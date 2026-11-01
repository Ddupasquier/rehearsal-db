/** Fixture-only public-CLI SQL scheduling; no product deadline is renewed. */
import assert from "node:assert/strict";
import { isLocalDockerEndpoint } from "../../../dist/src/runtime/engines/local_docker_context.mjs";
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { delimiter, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as pause } from "node:timers/promises";

const TLS =
  "{{if or .TLSMaterial .Endpoints.docker.SkipTLSVerify}}true{{else}}false{{end}}";
const CONTAINER =
  '{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"imageId":{{json .Image}},"labels":{{json .Config.Labels}},"running":{{json .State.Running}},"ports":{{json .NetworkSettings.Ports}}}';
const PSQL = [
  "/usr/bin/env",
  "-i",
  "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  "PGSSLMODE=disable",
  "PGPASSFILE=/dev/null",
  "psql",
  "--no-psqlrc",
  "--no-password",
  "--host=/var/run/postgresql",
  "--port=5432",
  "--quiet",
  "--no-align",
  "--tuples-only",
  "--set",
  "ON_ERROR_STOP=1",
  "--set",
  "VERBOSITY=sqlstate",
  "--username",
  "postgres",
  "--dbname",
  "postgres",
];
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const METADATA_JOURNAL = "metadata.jsonl";
const METADATA_BYTES = 16384;
const METADATA_ACTIONS = [
  "context-endpoint",
  "context-tls",
  "daemon-id",
  "container-inspect",
];
const METADATA_SIGNALS = [
  "SIGINT",
  "SIGTERM",
  "SIGKILL",
  "SIGHUP",
  "error",
  "unknown",
];
const refused = () =>
  new Error(
    "The bounded impact SQL gate refused its fixed fixture contract; private output withheld.",
  );
export function classifyImpactGateCommand(args, binding) {
  if (
    !binding ||
    !isLocalDockerEndpoint(binding.endpoint) ||
    binding.endpoint.toLowerCase().startsWith("https:") ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(binding.context) ||
    !/^[a-f0-9]{64}$/u.test(binding.containerId) ||
    !/^[a-z0-9-]{2,63}-postgresql$/u.test(binding.containerName)
  )
    throw refused();
  if (
    !Array.isArray(args) ||
    args.length > 32 ||
    args.some((a) => typeof a !== "string" || /[\r\n\0]/u.test(a))
  )
    throw refused();
  if (
    ["{{json .Endpoints.docker.Host}}", TLS].some((format) =>
      equal(args, ["context", "inspect", "--format", format, binding.context]),
    )
  )
    return "metadata";
  const prefix = ["--host", binding.endpoint];
  if (equal(args, [...prefix, "info", "--format", "{{json .ID}}"]))
    return "metadata";
  if (
    [binding.containerId, binding.containerName].some((id) =>
      equal(args, [
        ...prefix,
        "container",
        "inspect",
        "--format",
        CONTAINER,
        id,
      ]),
    )
  )
    return "metadata";
  if (
    equal(args, [
      ...prefix,
      "exec",
      "--interactive",
      binding.containerId,
      ...PSQL,
    ])
  )
    return "sql";
  throw refused();
}
async function privateDirectory(path) {
  if (!isAbsolute(path) || (await realpath(path)) !== path) throw refused();
  const s = await lstat(path);
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    s.mode & 0o077 ||
    (process.getuid && s.uid !== process.getuid())
  )
    throw refused();
  return { dev: s.dev, ino: s.ino };
}

const privateMetadataFile = (value) => {
  if (
    !value.isFile() ||
    value.nlink !== 1 ||
    value.size > METADATA_BYTES ||
    value.mode & 0o077 ||
    (process.getuid && value.uid !== process.getuid())
  )
    throw refused();
};
const metadataFact = (value) => {
  if (
    !value ||
    !equal(
      Object.keys(value).sort(),
      [
        "action",
        "stage",
        "elapsedMs",
        "status",
        "signal",
        "abortObserved",
      ].sort(),
    ) ||
    !METADATA_ACTIONS.includes(value.action) ||
    !["started", "closed"].includes(value.stage) ||
    !Number.isSafeInteger(value.elapsedMs) ||
    value.elapsedMs < 0 ||
    value.elapsedMs > 120000 ||
    !(
      value.status === null ||
      (Number.isSafeInteger(value.status) &&
        value.status >= 0 &&
        value.status <= 255)
    ) ||
    !(value.signal === null || METADATA_SIGNALS.includes(value.signal)) ||
    typeof value.abortObserved !== "boolean" ||
    (value.stage === "started" &&
      (value.status !== null || value.signal !== null))
  )
    throw refused();
  return {
    action: value.action,
    stage: value.stage,
    elapsedMs: value.elapsedMs,
    status: value.status,
    signal: value.signal,
    abortObserved: value.abortObserved,
  };
};
async function recordMetadata(root, fact) {
  let handle;
  try {
    const identity = await privateDirectory(root);
    handle = await open(
      join(root, METADATA_JOURNAL),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_APPEND |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK,
      0o600,
    );
    const before = await handle.stat();
    privateMetadataFile(before);
    const line = JSON.stringify(metadataFact(fact)) + "\n";
    if (before.size + Buffer.byteLength(line) > METADATA_BYTES - 32) {
      // A bounded overflow sentinel makes a truncated history unavailable.
      if (before.size + 18 <= METADATA_BYTES)
        await handle.writeFile('{"overflow":true}\n');
      return;
    }
    if (!equal(identity, await privateDirectory(root))) return;
    await handle.writeFile(line);
  } catch {
    // Diagnostics cannot authorize a command, change its outcome or mask its error.
  } finally {
    await handle?.close().catch(() => {});
  }
}
async function readMetadata(root) {
  const unavailable = (state) => ({
    state,
    started: null,
    closed: null,
    last: null,
  });
  try {
    const text = await gateFile(root, METADATA_JOURNAL, METADATA_BYTES);
    if (!text.endsWith("\n")) throw refused();
    const lines = text.slice(0, -1).split("\n");
    if (!lines.length || lines.length > 128) throw refused();
    const facts = lines.map((line) => metadataFact(JSON.parse(line)));
    return {
      state: "recorded",
      started: facts.filter((x) => x.stage === "started").length,
      closed: facts.filter((x) => x.stage === "closed").length,
      last: facts.at(-1),
    };
  } catch (error) {
    return unavailable(error.code === "ENOENT" ? "absent" : "unavailable");
  }
}
async function gateFile(root, name, maximumBytes = 32) {
  const before = await privateDirectory(root);
  const handle = await open(
    join(root, name),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const s = await handle.stat();
    if (
      !s.isFile() ||
      s.size > maximumBytes ||
      s.mode & 0o077 ||
      (process.getuid && s.uid !== process.getuid())
    )
      throw refused();
    const bytes = Buffer.alloc(maximumBytes + 1),
      { bytesRead } = await handle.read(bytes, 0, bytes.length, 0),
      after = await handle.stat();
    if (
      bytesRead !== s.size ||
      after.size !== s.size ||
      after.ino !== s.ino ||
      after.mtimeMs !== s.mtimeMs ||
      !equal(before, await privateDirectory(root))
    )
      throw refused();
    return bytes.subarray(0, bytesRead).toString();
  } finally {
    await handle.close();
  }
}
// Publish only complete, closed bytes. Exclusive linking preserves the old wx
// refusal on existing files/symlinks without exposing an in-progress write.
export async function publishImpactGateSignal(root, name) {
  if (!["ready", "release"].includes(name)) throw refused();
  const identity = await privateDirectory(root);
  const temporary = join(root, `.signal-${randomUUID()}`);
  try {
    await writeFile(temporary, `${name}\n`, { mode: 0o600, flag: "wx" });
    if (!equal(identity, await privateDirectory(root))) throw refused();
    await link(temporary, join(root, name));
    if (!equal(identity, await privateDirectory(root))) throw refused();
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
export async function waitForImpactGateReady({
  client,
  readReady,
  expiresAt,
  now = Date.now,
  wait = () => pause(25),
}) {
  while (
    now() < expiresAt &&
    client.child.exitCode === null &&
    client.child.signalCode === null
  ) {
    if (await readReady()) return;
    await wait();
  }
  throw refused();
}
export async function runImpactGateWrapper(config, args) {
  const remaining = config.expiresAt - Date.now();
  if (
    !Number.isSafeInteger(config.expiresAt) ||
    remaining <= 0 ||
    remaining > 35000 ||
    !isAbsolute(config.docker) ||
    (await realpath(config.docker)) !== config.docker
  )
    throw refused();
  await privateDirectory(config.root);
  const kind = classifyImpactGateCommand(args, config.binding);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const events = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const event of events) process.on(event, cancel);
  const timer = setTimeout(cancel, remaining);
  try {
    if (kind === "sql") {
      await publishImpactGateSignal(config.root, "ready");
      while (true) {
        controller.signal.throwIfAborted();
        try {
          if ((await gateFile(config.root, "release")) !== "release\n")
            throw refused();
          break;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
        await pause(10, undefined, { signal: controller.signal });
      }
    }
    controller.signal.throwIfAborted();
    const action =
      kind === "metadata"
        ? args[0] === "context"
          ? args[3] === TLS
            ? "context-tls"
            : "context-endpoint"
          : args[2] === "info"
            ? "daemon-id"
            : "container-inspect"
        : null;
    const started = performance.now();
    const record = (stage, result = { status: null, signal: null }) =>
      action === null
        ? undefined
        : recordMetadata(config.root, {
            action,
            stage,
            elapsedMs: Math.min(
              120000,
              Math.max(0, Math.round(performance.now() - started)),
            ),
            status:
              Number.isSafeInteger(result.status) &&
              result.status >= 0 &&
              result.status <= 255
                ? result.status
                : null,
            signal:
              result.signal === null
                ? null
                : METADATA_SIGNALS.includes(result.signal)
                  ? result.signal
                  : "unknown",
            abortObserved: controller.signal.aborted,
          });
    if (action !== null) {
      await record("started");
      controller.signal.throwIfAborted();
    }
    const child = spawn(config.docker, args, {
      env: process.env,
      detached: process.platform !== "win32",
      stdio: [kind === "sql" ? "pipe" : "ignore", "inherit", "inherit"],
    });
    let killTimer;
    const signalChild = (signal) => {
      try {
        if (process.platform !== "win32" && child.pid)
          process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    };
    const stop = () => {
      signalChild("SIGTERM");
      killTimer ??= setTimeout(() => signalChild("SIGKILL"), 250);
    };
    controller.signal.addEventListener("abort", stop, { once: true });
    if (controller.signal.aborted) stop();
    if (kind === "sql") {
      child.stdin.on("error", () => {});
      process.stdin.pipe(child.stdin);
    }
    const result = await new Promise((done) => {
      child.once("error", () => done({ status: null, signal: "error" }));
      child.once("close", (status, signal) => done({ status, signal }));
    });
    clearTimeout(killTimer);
    controller.signal.removeEventListener("abort", stop);
    if (kind === "sql") process.stdin.unpipe(child.stdin);
    const failed =
      controller.signal.aborted || result.signal || result.status !== 0;
    if (action !== null) await record("closed", result);
    if (failed) throw refused();
  } finally {
    clearTimeout(timer);
    for (const event of events) process.removeListener(event, cancel);
  }
}
export async function createImpactSqlGate({
  cwd,
  docker,
  binding,
  path = process.env.PATH ?? "",
}) {
  const parent = await realpath(cwd),
    root = join(parent, ".impact-sql-gate-" + randomUUID());
  assert.ok(isAbsolute(docker));
  docker = await realpath(docker);
  await mkdir(root, { mode: 0o700 });
  const identity = await privateDirectory(root),
    expiresAt = Date.now() + 35000;
  const config = { root, docker, binding, expiresAt };
  const wrapper = join(root, "docker");
  const source = [
    `#!${process.execPath}`,
    `import { runImpactGateWrapper } from ${JSON.stringify(pathToFileURL(import.meta.filename).href)};`,
    `runImpactGateWrapper(${JSON.stringify(config)},process.argv.slice(2)).catch(()=>{process.stderr.write(${JSON.stringify("Impact fixture gate refused; private output withheld.\n")});process.exitCode=1;});`,
    "",
  ].join("\n");
  await writeFile(wrapper, source, { mode: 0o700, flag: "wx" });

  return {
    expiresAt,
    environment: { PATH: root + delimiter + path },
    readMetadata: () => readMetadata(root),
    readReady: async () => {
      try {
        return (await gateFile(root, "ready")) === "ready\n";
      } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    },
    release: async () => {
      if (
        Date.now() >= expiresAt ||
        !equal(identity, await privateDirectory(root))
      )
        throw refused();
      await publishImpactGateSignal(root, "release");
    },
    cleanup: async () => {
      if (!equal(identity, await privateDirectory(root))) throw refused();
      await rm(root, { recursive: true });
    },
  };
}

/** Fixture phases share the original public/cancellation clocks; holder release does not await CLI postvalidation. */
export async function completeImpactBlockedMeasurement({
  client,
  awaitReady,
  hold,
  releaseGate,
  waitForLock,
  waitForBackendGone,
  releaseHolder,
  cancel = false,
  startedAt,
  now = () => performance.now(),
}) {
  await awaitReady();
  const holder = await hold();
  await releaseGate();
  const pid = await waitForLock();
  let cancellationStarted = null,
    timer;
  if (cancel) {
    cancellationStarted = now();
    client.child.kill("SIGINT");
  }
  const cleanup = async () => {
    await waitForBackendGone(pid);
    await releaseHolder(holder);
  };
  let result;
  try {
    if (cancel) {
      // Start this timer at SIGINT, concurrently with backend disappearance and release.
      const remaining = 10000 - (now() - cancellationStarted);
      if (remaining <= 0) throw refused();
      const expired = new Promise((_, reject) => {
        timer = setTimeout(() => {
          client.stop();
          reject(refused());
        }, remaining);
      });
      [result] = await Promise.race([
        Promise.all([client.completion, cleanup()]),
        expired,
      ]);
    } else {
      await cleanup();
      result = await client.completion;
    }
    const elapsedMilliseconds = Math.round(now() - startedAt);
    const cancellationMilliseconds = cancel
      ? Math.round(now() - cancellationStarted)
      : null;
    if (
      elapsedMilliseconds > 30000 ||
      elapsedMilliseconds < 0 ||
      (cancel &&
        (cancellationMilliseconds > 10000 || cancellationMilliseconds < 0))
    )
      throw refused();
    return { result, pid, elapsedMilliseconds, cancellationMilliseconds };
  } finally {
    clearTimeout(timer);
  }
}
