import {
  mkdtemp,
  mkdir,
  realpath,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "@lydell/node-pty";
import { createCleanProcessEnvironment } from "../../dist/src/shared/process_environment.mjs";
import { stopOwnedPosixProcessGroup } from "../../dist/src/application/process_group.mjs";

const roots = [];
const retainedRoots = new Set();
const runFile = promisify(execFile);
const sessionModule = pathToFileURL(
  join(process.cwd(), "dist/src/application/session.mjs"),
).href;
const taskModule = pathToFileURL(
  join(process.cwd(), "dist/src/application/interactive_task.mjs"),
).href;
const cancellationModule = pathToFileURL(
  join(process.cwd(), "dist/src/shared/cancellation.mjs"),
).href;
const terminalModule = pathToFileURL(
  join(process.cwd(), "dist/src/cli/terminal.mjs"),
).href;
const diagnosticsModule = pathToFileURL(
  join(process.cwd(), "dist/src/shared/diagnostics.mjs"),
).href;
const cliModule = pathToFileURL(
  join(process.cwd(), "dist/src/cli/rehearsal.mjs"),
).href;

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .filter((root) => !retainedRoots.has(root))
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

const runForegroundJob = async (control, mode, phase = "ready") => {
  const root = await mkdtemp(join(tmpdir(), "rehearsal-terminal-job-"));
  roots.push(root);
  const publicOpen = mode === "public-open" || mode === "guided-open";
  let discoveryInfrastructureCalls = "";
  await mkdir(join(root, "node_modules/.bin"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "terminal-job-fixture",
      version: "1.0.0",
      private: true,
    }),
  );
  if (mode === "startup" || mode === "handoff") {
    await writeFile(join(root, "startup.env"), "", { mode: 0o600 });
    await writeFile(
      join(root, "startup-child.mjs"),
      `import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
writeFileSync("startup-child.owner.json", JSON.stringify({
  pid: process.pid, script: process.argv[1],
  identity: execFileSync("ps", ["-p", String(process.pid), "-o", "pgid=,lstart=,command="], { encoding: "utf8", timeout: 1000, maxBuffer: 4096 }).trim()
}));
writeFileSync("startup-child.pid", String(process.pid));
process.on("SIGTERM", () => {
  writeFileSync("startup-child.stopped", "yes");
  process.exit(0);
});
writeFileSync("startup-child.ready", "yes");
setInterval(() => {}, 1000);
`,
    );
  }
  if (publicOpen) {
    await mkdir(join(root, "database/migrations"), { recursive: true });
    await mkdir(join(root, "denied-infrastructure"));
    for (const command of ["docker", "colima", "supabase"]) {
      await writeFile(
        join(root, "denied-infrastructure", command),
        `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(${JSON.stringify(join(root, "infra.calls"))}, ${JSON.stringify(command + "\n")});
process.exit(99);
`,
        { mode: 0o700 },
      );
    }
    await writeFile(
      join(root, "rehearsal.config.mjs"),
      `import { existsSync } from "node:fs";
if (${JSON.stringify(mode)} === "public-open" || existsSync("guided-open-selected")) {
  console.log("OWNED_PUBLIC_OPEN_WAITING");
  await new Promise((resolve) => setTimeout(resolve, 300));
}
export default {
  schemaVersion: 1, project: { name: "terminal-public-open" },
  postgresql: { migrationDirectory: "database/migrations", runtimeWorkdir: ".rehearsal/runtime", image: "postgres:17-alpine", database: "postgres", user: "postgres" },
  baseline: { artifactDirectory: ".rehearsal", sanitizationPolicy: "rehearsal/sanitization-policy.json" },
  application: { startCommand: "node unused-app.mjs", proofCommand: "node unused-proof.mjs", readiness: { url: "http://127.0.0.1:51980", expectedStatus: 200, timeoutSeconds: 5 } },
  runtime: { target: "postgresql", applicationUrl: "http://127.0.0.1:51980", projectId: "terminal-public-open", databasePort: 59422 },
  safety: { hostedAccess: "disabled", outboundNetwork: "deny" }
};
`,
    );
    if (mode === "guided-open") {
      // Guide availability is a local path check, not proof of a running stack.
      // This synthetic marker makes Open selectable without launching a database.
      await mkdir(join(root, ".rehearsal/runtime"), { recursive: true });
      await writeFile(join(root, ".rehearsal/runtime/baseline.json"), "{}\n");
    }
  }
  await writeFile(
    join(root, "holder.mjs"),
    publicOpen
      ? `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync("wrapper.pid", String(process.ppid));
await import(${JSON.stringify(cliModule)});
`
      : `#!/usr/bin/env node
import { holdApplicationSession, startApplicationSession } from ${JSON.stringify(sessionModule)};
import { runApplicationSessionTask } from ${JSON.stringify(taskModule)};
import { runWithOperationCancellation, throwIfOperationCancelled, isOperationCancelled } from ${JSON.stringify(cancellationModule)};
import { installGuidedExitShortcut, promptForConfirmation, useStyledPrompts } from ${JSON.stringify(terminalModule)};
import { normalizeRehearsalError } from ${JSON.stringify(diagnosticsModule)};
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
writeFileSync("wrapper.pid", String(process.ppid));
const keepAlive = setInterval(() => {}, 1000);
const mode = ${JSON.stringify(mode)};
const removeGuidedShortcut = mode === "identity" ? installGuidedExitShortcut({ plain: true }) : () => {};
let announced = false;
const launchStartup = (ready) => startApplicationSession({
  command: JSON.stringify(process.execPath) + " " + JSON.stringify(join(process.cwd(), "startup-child.mjs")),
  cwd: process.cwd(), files: { primary: "startup.env" }, mappings: {},
  readiness: { url: "http://127.0.0.1:51980", timeoutSeconds: 5 },
  portPreflight: async () => {},
  fetchImplementation: async () => {
    const deadline = Date.now() + 1000;
    while (!existsSync("startup-child.ready") && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    if (!existsSync("startup-child.ready")) throw new Error("Synthetic startup child did not become ready.");
    if (!ready && !announced) {
      announced = true;
      // Deliberate harness fault injection: let wrapper termination bypass this
      // synthetic CLI's cleanup, proving the harness reaps its detached child.
      if (${JSON.stringify(phase)} === "timeout") process.removeAllListeners("SIGTERM");
      console.log("TERMINAL_STARTUP_RAW=" + process.stdin.isRaw);
      console.log("OWNED_STARTUP_WAITING");
    }
    return new Response(ready ? "ready" : "waiting", { status: ready ? 200 : 503 });
  },
});
try {
  console.log("TERMINAL_BEFORE_RAW=" + process.stdin.isRaw);
  console.log("TERMINAL_BEFORE_FLOWING=" + (process.stdin.readableFlowing === true));
  const options = {
    session: {
      ready: { url: "http://127.0.0.1:51980", status: 200 },
      wait: () => new Promise(() => {}),
      stop: async () => { console.log("OWNED_SESSION_STOPPED"); },
      diagnostics: () => ({ stdoutBytes: 0, stderrBytes: 0 }),
    },
    onReady: () => {
      console.log("TERMINAL_DURING_RAW=" + process.stdin.isRaw);
      console.log("OWNED_SESSION_READY");
    },
  };
  let result;
  if (mode === "startup" || mode === "handoff") {
    try {
      if (mode === "startup") await launchStartup(false);
      else await runWithOperationCancellation({ task: async (signal) => {
        const session = await launchStartup(true);
        const interrupted = new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        console.log("OWNED_HANDOFF_WAITING");
        await interrupted;
        return holdApplicationSession({ session, onReady: () => console.log("UNEXPECTED_HANDOFF_READY") });
      } });
      throw new Error("Synthetic 503 readiness unexpectedly succeeded.");
    } catch (error) {
      const failure = normalizeRehearsalError(error);
      console.log("STARTUP_ERROR_CATEGORY=" + failure.category);
      console.log("STARTUP_ERROR_CODE=" + failure.code);
      console.log("STARTUP_ERROR_EXIT=" + failure.exitCode);
      console.log("STARTUP_ERROR_MESSAGE=" + error.message);
      process.exitCode = failure.exitCode;
      result = { signal: failure.context.signal ?? error.message.match(/interrupted by (SIGINT|SIGTSTP)\./u)?.[1] };
    }
  } else if (mode.startsWith("mutation-")) {
    try {
      await runWithOperationCancellation({ task: async (signal) => {
        const flags = { plain: mode === "mutation-plain" };
        console.log("CONFIRM_STYLE=" + useStyledPrompts(flags));
        const accepted = await promptForConfirmation("Allow fixture cancellation check?", flags);
        if (!accepted) throw new Error("Fixture confirmation was refused.");
        options.onReady();
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        throwIfOperationCancelled();
      } });
    } catch (error) {
      if (!isOperationCancelled(error)) throw error;
      console.log("OWNED_SESSION_STOPPED");
      result = { signal: error.context.signal };
      process.exitCode = error.exitCode;
    }
  } else {
    result = mode === "hold" || mode === "hold-outer"
      ? mode === "hold-outer" ? await runWithOperationCancellation({ task: () => holdApplicationSession(options) }) : await holdApplicationSession(options)
      : await runApplicationSessionTask({ ...options, task: (signal) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }) });
  }
  console.log("OWNED_SESSION_RESULT=" + result.signal);
  console.log("TERMINAL_AFTER_RAW=" + process.stdin.isRaw);
  console.log("TERMINAL_AFTER_FLOWING=" + process.stdin.readableFlowing);
} finally { removeGuidedShortcut(); process.stdin.pause(); clearInterval(keepAlive); }
`,
    { mode: 0o700 },
  );
  const reviewedConfiguration = publicOpen
    ? await readFile(join(root, "rehearsal.config.mjs"), "utf8")
    : null;
  await symlink("../../holder.mjs", join(root, "node_modules/.bin/rehearsal"));
  const script = `stty -g > before.tty
zmodload zsh/parameter
setopt MONITOR
[[ -o monitor ]] || exit 7
npx --offline --no-install rehearsal ${mode === "guided-open" ? "--plain" : `open ${mode === "public-open" ? "--json" : ""}`}
fixture_status=$?
print -r -- "WRAPPER_EXIT=$fixture_status"
print -rl -- \${(k)jobstates} > remaining.jobs
jobs -l
stty -g > after.tty
# A failed regression must not itself leave a stopped fixture wrapper behind.
# These are this shell's exact owned jobs, not discovered product ancestors.
for fixture_job in \${(k)jobstates}; do
  kill -TERM %$fixture_job 2>/dev/null
  kill -CONT %$fixture_job 2>/dev/null
done
for fixture_attempt in {1..50}; do
  (( \${#jobstates} == 0 )) && break
  sleep 0.02
done
for fixture_job in \${(k)jobstates}; do
  kill -KILL %$fixture_job 2>/dev/null
done
for fixture_attempt in {1..50}; do
  (( \${#jobstates} == 0 )) && break
  sleep 0.02
done
print -rl -- \${(k)jobstates} > cleanup.jobs
if ps -p "$(< wrapper.pid)" -o pid= > wrapper.remaining; then
  print -r -- "WRAPPER_STILL_PRESENT"
fi
print -r -- "SHELL_CHECKS_FINISHED"
exit 0
`;
  await writeFile(join(root, "job.zsh"), script);
  const reapStartupChild = async () => {
    if (mode !== "startup" && mode !== "handoff") return false;
    let owner;
    try {
      owner = JSON.parse(
        await readFile(join(root, "startup-child.owner.json"), "utf8"),
      );
    } catch (error) {
      if (
        error.code === "ENOENT" &&
        !existsSync(join(root, "startup-child.pid"))
      )
        return false;
      throw error;
    }
    if (
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 1 ||
      typeof owner.identity !== "string" ||
      typeof owner.script !== "string" ||
      (await realpath(owner.script)) !==
        (await realpath(join(root, "startup-child.mjs"))) ||
      !owner.identity.includes(owner.script) ||
      Number(owner.identity.split(/\s+/u)[0]) !== owner.pid
    )
      throw new Error(
        "Detached fixture child ownership record is invalid; no process was signaled.",
      );
    const identity = await runFile(
      "ps",
      ["-p", String(owner.pid), "-o", "pgid=,lstart=,command="],
      { timeout: 1000 },
    )
      .then(({ stdout }) => stdout.trim())
      .catch((error) => {
        if (error.code === 1) return "";
        throw error;
      });
    if (!identity) return "already-absent";
    if (identity !== owner.identity)
      throw new Error(
        "Detached fixture child identity changed; no process was signaled.",
      );
    await stopOwnedPosixProcessGroup({ pid: owner.pid });
    return "reaped";
  };
  const output = await new Promise((resolve, reject) => {
    const terminal = spawn("/bin/zsh", ["-f", "-i"], {
      name: "xterm-256color",
      cols: 120,
      rows: 30,
      cwd: root,
      env: createCleanProcessEnvironment({
        inheritedEnvironment: {
          ...process.env,
          CI: undefined,
          NO_COLOR: undefined,
        },
        overrides: {
          PROMPT: "FIXTURE_SHELL_READY> ",
          RPROMPT: "",
          REHEARSAL_UPDATE_CHECK: "off",
          COLORTERM: "truecolor",
          TERM: "xterm-256color",
          npm_config_cache: join(root, "npm-cache"),
          npm_config_audit: "false",
          npm_config_fund: "false",
          npm_config_update_notifier: "false",
          PATH: [join(root, "denied-infrastructure"), process.env.PATH]
            .filter(Boolean)
            .join(":"),
        },
      }),
    });
    let output = "";
    let launched = false;
    let interrupted = false;
    let answered = false;
    let selectedGuidedOpen = false;
    let promptFallback;
    let promptNeededFallback = false;
    let timeoutFailure;
    let exitResult;
    let settled = false;
    let cleanup = Promise.resolve();
    const settle = async () => {
      if (!exitResult) return;
      await cleanup;
      if (settled) return;
      settled = true;
      output += `\nPROMPT_NEEDED_FALLBACK=${promptNeededFallback}\n`;
      if (timeoutFailure) reject(timeoutFailure);
      else if (exitResult.exitCode === 0) resolve(output);
      else
        reject(
          new Error(
            `Foreground terminal fixture exited ${exitResult.exitCode}: ${output}`,
          ),
        );
    };
    const failTimeout = () => {
      timeoutFailure = new Error(
        `Foreground terminal fixture timed out: ${output}`,
      );
      cleanup = (async () => {
        try {
          const wrapper = Number(
            await readFile(join(root, "wrapper.pid"), "utf8"),
          );
          if (Number.isSafeInteger(wrapper) && wrapper > 1) {
            const { stdout } = await runFile(
              "ps",
              ["-p", String(wrapper), "-o", "ppid=,pgid="],
              { timeout: 1000 },
            );
            const [parent, group] = stdout.trim().split(/\s+/u).map(Number);
            // The fresh interactive shell and its exact foreground group establish
            // fixture ownership. Never signal a discovered parent or foreign job.
            if (parent === terminal.pid && group === wrapper)
              await stopOwnedPosixProcessGroup({ pid: wrapper });
            else
              throw new Error(
                "Timed-out fixture wrapper ownership could not be established.",
              );
          }
        } catch (error) {
          if (error?.code !== "ENOENT" && error?.code !== 1)
            timeoutFailure = new AggregateError(
              [timeoutFailure, error],
              "Foreground fixture cleanup failed.",
            );
        } finally {
          try {
            timeoutFailure.ownedStartupChildReaped = await reapStartupChild();
          } catch (error) {
            retainedRoots.add(root);
            timeoutFailure = new AggregateError(
              [timeoutFailure, error],
              "Detached fixture child cleanup failed; private ownership evidence was retained.",
            );
          }
          // Do not signal an already-reaped PTY, and join this cleanup before
          // onExit settles the fixture or afterEach removes its workspace.
          if (!exitResult) terminal.kill();
        }
      })().catch((error) => {
        timeoutFailure = new AggregateError(
          [timeoutFailure, error],
          "Foreground fixture cleanup failed.",
        );
      });
      void cleanup.then(settle);
    };
    let timeout = setTimeout(failTimeout, 10_000);
    terminal.onData((chunk) => {
      output += chunk;
      if (!launched && output.includes("FIXTURE_SHELL_READY> ")) {
        launched = true;
        terminal.write("source ./job.zsh\r");
      }
      if (
        mode === "guided-open" &&
        !selectedGuidedOpen &&
        output.includes("[1]: ")
      ) {
        const choice = output.match(/(\d+)\. Open the sandbox app/u)?.[1];
        if (choice) {
          selectedGuidedOpen = true;
          // Re-loading this owned configuration now proves the selected Open
          // boundary, not the uncancellable home-screen inspection itself.
          void readFile(join(root, "infra.calls"), "utf8")
            .catch((error) => {
              if (error.code === "ENOENT") return "";
              throw error;
            })
            .then((calls) => {
              // The home screen may probe Docker status through our denied
              // stub. Assert the selected Open adds no infrastructure request.
              discoveryInfrastructureCalls = calls;
              return writeFile(join(root, "guided-open-selected"), "yes\n");
            })
            .then(() => terminal.write(`${choice}\r`))
            .catch((error) => {
              timeoutFailure = error;
              terminal.kill();
            });
        }
      }
      if (!interrupted && output.includes("OWNED_SESSION_READY")) {
        interrupted = true;
        terminal.write(control);
      }
      if (
        !interrupted &&
        [
          "OWNED_STARTUP_WAITING",
          "OWNED_HANDOFF_WAITING",
          "OWNED_PUBLIC_OPEN_WAITING",
        ].some((marker) => output.includes(marker))
      ) {
        interrupted = true;
        if (phase === "timeout") {
          clearTimeout(timeout);
          timeout = setTimeout(failTimeout, 100);
        } else terminal.write(control);
      }
      if (!answered && output.includes("Allow fixture cancellation check?")) {
        answered = true;
        if (phase === "prompt") {
          interrupted = true;
          terminal.write(control);
          // Bound the diagnostic experiment without leaking a stuck prompt:
          // a correct cancellation exits without needing this synthetic refusal.
          promptFallback = setTimeout(() => {
            promptNeededFallback = true;
            terminal.write(mode === "mutation-plain" ? "n\r" : "n");
          }, 1000);
        } else terminal.write(mode === "mutation-plain" ? "y\r" : "y");
      }
    });
    terminal.onExit((result) => {
      exitResult = result;
      clearTimeout(timeout);
      clearTimeout(promptFallback);
      void settle();
    });
  }).catch(async (error) => {
    try {
      await reapStartupChild();
    } catch (cleanupError) {
      retainedRoots.add(root);
      throw new AggregateError(
        [error, cleanupError],
        "Foreground fixture failed and detached cleanup was not verified; private evidence was retained.",
      );
    }
    throw error;
  });
  let startupChild = null;
  if (mode === "startup" || mode === "handoff") {
    const pid = (
      await readFile(join(root, "startup-child.pid"), "utf8")
    ).trim();
    const remaining = await runFile("ps", ["-p", pid, "-o", "pid="], {
      timeout: 1000,
    })
      .then(({ stdout }) => stdout.trim())
      .catch((error) => {
        if (error.code === 1) return "";
        throw error;
      });
    if (remaining) {
      try {
        await reapStartupChild();
      } catch (error) {
        retainedRoots.add(root);
        throw error;
      }
    }
    startupChild = {
      remaining,
      stopped: (
        await readFile(join(root, "startup-child.stopped"), "utf8")
      ).trim(),
    };
  }
  return {
    output,
    jobs: (await readFile(join(root, "remaining.jobs"), "utf8")).trim(),
    before: (await readFile(join(root, "before.tty"), "utf8")).trim(),
    after: (await readFile(join(root, "after.tty"), "utf8")).trim(),
    wrapper: (await readFile(join(root, "wrapper.remaining"), "utf8")).trim(),
    cleanupJobs: (await readFile(join(root, "cleanup.jobs"), "utf8")).trim(),
    startupChild,
    publicOpen: publicOpen
      ? {
          infrastructureCalls: await readFile(join(root, "infra.calls"), "utf8")
            .catch((error) => {
              if (error.code === "ENOENT") return "";
              throw error;
            })
            .then((calls) => {
              expect(calls.startsWith(discoveryInfrastructureCalls)).toBe(true);
              return calls.slice(discoveryInfrastructureCalls.length);
            }),
          runtimeCreated:
            mode === "guided-open"
              ? (await readFile(
                  join(root, ".rehearsal/runtime/baseline.json"),
                  "utf8",
                )) !== "{}\n"
              : existsSync(join(root, ".rehearsal/runtime")),
          lockPresent: existsSync(
            join(
              tmpdir(),
              "rehearsal-db-operation-locks",
              createHash("sha256")
                .update(await realpath(root))
                .digest("hex"),
            ),
          ),
          configurationPreserved:
            (await readFile(join(root, "rehearsal.config.mjs"), "utf8")) ===
            reviewedConfiguration,
        }
      : null,
  };
};

describe.skipIf(process.platform === "win32" || !existsSync("/bin/zsh"))(
  "interactive shell foreground job control",
  () => {
    it("reaps its separately detached startup child before rejecting an intentional fixture timeout", async () => {
      const failure = await runForegroundJob(
        "\u001a",
        "startup",
        "timeout",
      ).catch((error) => error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toContain("timed out");
      expect(failure.ownedStartupChildReaped).toBe("reaped");
    }, 20_000);
    it.each(
      [
        "hold",
        "hold-outer",
        "identity",
        "mutation-plain",
        "mutation-styled",
      ].flatMap((mode) => [
        [mode, "Ctrl+C", "\u0003", "SIGINT"],
        [mode, "Ctrl+Z", "\u001a", "SIGTSTP"],
      ]),
    )(
      "%s %s retires the npm wrapper, owned session, and restores the terminal",
      async (mode, _label, control, signal) => {
        const result = await runForegroundJob(control, mode);
        expect(result.output).toContain("OWNED_SESSION_STOPPED");
        expect(result.output).toContain(`OWNED_SESSION_RESULT=${signal}`);
        expect(result.output).toContain(
          `WRAPPER_EXIT=${mode.startsWith("mutation-") ? 130 : 0}`,
        );
        expect(result.output).toContain("SHELL_CHECKS_FINISHED");
        expect(result.jobs).toBe("");
        expect(result.cleanupJobs).toBe("");
        expect(result.wrapper).toBe("");
        expect(result.after).toBe(result.before);
        expect(result.output).toContain("TERMINAL_BEFORE_RAW=false");
        expect(result.output).toContain("TERMINAL_DURING_RAW=true");
        expect(result.output).toContain("TERMINAL_AFTER_RAW=false");
        const priorFlowing = result.output.match(
          /TERMINAL_BEFORE_FLOWING=(true|false)/u,
        )?.[1];
        expect(priorFlowing).toBeDefined();
        expect(result.output).toContain(
          `TERMINAL_AFTER_FLOWING=${priorFlowing}`,
        );
        if (mode.startsWith("mutation-"))
          expect(result.output).toContain(
            `CONFIRM_STYLE=${mode === "mutation-styled"}`,
          );
      },
      20_000,
    );
    it.each([
      ["Ctrl+C", "\u0003", "SIGINT"],
      ["Ctrl+Z", "\u001a", "SIGTSTP"],
    ])(
      "startup %s does not leave a suspended wrapper or owned child",
      async (label, control, signal) => {
        const result = await runForegroundJob(control, "startup", "startup");
        console.info(
          JSON.stringify({
            case: `startup ${label}`,
            wrapperExit: result.output.match(/WRAPPER_EXIT=(\d+)/u)?.[1],
            category: result.output.match(
              /STARTUP_ERROR_CATEGORY=([^\r\n]+)/u,
            )?.[1],
            code: result.output.match(/STARTUP_ERROR_CODE=([^\r\n]+)/u)?.[1],
            exit: result.output.match(/STARTUP_ERROR_EXIT=(\d+)/u)?.[1],
            jobs: result.jobs,
            cleanupJobs: result.cleanupJobs,
            child: result.startupChild,
          }),
        );
        expect(result.output).toContain("OWNED_STARTUP_WAITING");
        expect(result.output).toContain(`OWNED_SESSION_RESULT=${signal}`);
        expect(result.output).not.toContain("OWNED_SESSION_READY");
        expect(result.output).toContain(
          "STARTUP_ERROR_CATEGORY=operation_cancelled",
        );
        expect(result.output).toContain(
          "STARTUP_ERROR_CODE=OPERATION_CANCELLED",
        );
        expect(result.output).toContain("WRAPPER_EXIT=130");
        expect(result.startupChild).toEqual({ remaining: "", stopped: "yes" });
        expect(result.cleanupJobs).toBe("");
        expect(result.wrapper).toBe("");
        expect(result.after).toBe(result.before);
        expect(result.jobs, result.output).toBe("");
      },
      20_000,
    );
    it.each([
      ["Ctrl+C", "\u0003"],
      ["Ctrl+Z", "\u001a"],
    ])(
      "guided Open %s cancels selected early preparation without infrastructure",
      async (_label, control) => {
        const result = await runForegroundJob(control, "guided-open");
        expect(result.output).toContain("OWNED_PUBLIC_OPEN_WAITING");
        expect(result.output).toContain("cancelled by");
        expect(result.output).toContain("WRAPPER_EXIT=130");
        expect(result.publicOpen).toEqual({
          infrastructureCalls: "",
          runtimeCreated: false,
          lockPresent: false,
          configurationPreserved: true,
        });
        expect(result.jobs).toBe("");
        expect(result.cleanupJobs).toBe("");
        expect(result.wrapper).toBe("");
        expect(result.after).toBe(result.before);
      },
      20_000,
    );
    it.each([
      ["Ctrl+C", "\u0003"],
      ["Ctrl+Z", "\u001a"],
    ])(
      "public Open %s cancels early preparation without infrastructure",
      async (_label, control) => {
        const result = await runForegroundJob(control, "public-open");
        expect(result.output).toContain('"category": "operation_cancelled"');
        expect(result.output).toContain('"code": "OPERATION_CANCELLED"');
        expect(result.output).toContain("WRAPPER_EXIT=130");
        expect(result.publicOpen).toEqual({
          infrastructureCalls: "",
          runtimeCreated: false,
          lockPresent: false,
          configurationPreserved: true,
        });
        expect(result.jobs).toBe("");
        expect(result.cleanupJobs).toBe("");
        expect(result.wrapper).toBe("");
        expect(result.after).toBe(result.before);
      },
      20_000,
    );
    it.each([
      ["Ctrl+C", "\u0003"],
      ["Ctrl+Z", "\u001a"],
    ])(
      "handoff %s retires a ready child instead of entering the holder",
      async (_label, control) => {
        const result = await runForegroundJob(control, "handoff");
        expect(result.output).toContain(
          "STARTUP_ERROR_CATEGORY=operation_cancelled",
        );
        expect(result.output).toContain(
          "STARTUP_ERROR_CODE=OPERATION_CANCELLED",
        );
        expect(result.output).toContain("WRAPPER_EXIT=130");
        expect(result.output).not.toContain("UNEXPECTED_HANDOFF_READY");
        expect(result.startupChild).toEqual({ remaining: "", stopped: "yes" });
        expect(result.jobs).toBe("");
        expect(result.cleanupJobs).toBe("");
        expect(result.wrapper).toBe("");
        expect(result.after).toBe(result.before);
      },
      20_000,
    );
    it.each(
      ["mutation-plain", "mutation-styled"].flatMap((mode) => [
        [mode, "Ctrl+C", "\u0003", "SIGINT"],
        [mode, "Ctrl+Z", "\u001a", "SIGTSTP"],
      ]),
    )(
      "%s %s cancels a pending confirmation without an answer",
      async (mode, _label, control, signal) => {
        const result = await runForegroundJob(control, mode, "prompt");
        expect(result.output).toContain("PROMPT_NEEDED_FALLBACK=false");
        expect(result.output).toContain(`OWNED_SESSION_RESULT=${signal}`);
        expect(result.output).toContain("WRAPPER_EXIT=130");
        expect(result.output).not.toContain("OWNED_SESSION_READY");
        expect(result.jobs).toBe("");
        expect(result.cleanupJobs).toBe("");
        expect(result.wrapper).toBe("");
        expect(result.after).toBe(result.before);
      },
      20_000,
    );
  },
);
