import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseLocalSupabaseEnvironment,
  preventOwnedSupabaseAutoRestart,
  supabaseExcludedServicesForProfile,
} from "../../../dist/src/targets/supabase_environment.mjs";

const execute = promisify(execFile);
const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

const fakeCommandEnvironment = async ({
  dockerReady = false,
  remote = false,
  colimaRunning = false,
  exactIds = false,
  conflictingOwnership = false,
} = {}) => {
  const root = await mkdtemp(join(tmpdir(), "rehearsal-runtime-test-"));
  temporaryRoots.push(root);
  const log = join(root, "commands.log");
  const ready = join(root, "docker-ready");
  if (dockerReady) await writeFile(ready, "ready\n");
  const commands = {
    docker: `#!/bin/sh
printf 'docker %s\\n' "$*" >> ${JSON.stringify(log)}
if [ "$1" = context ] && [ "$2" = show ]; then printf 'colima\\n'; exit 0; fi
if [ "$1" = context ] && [ "$2" = inspect ] && [ "$4" = '{{if or .TLSMaterial .Endpoints.docker.SkipTLSVerify}}true{{else}}false{{end}}' ]; then printf 'false\\n'; exit 0; fi
if [ "$1" = context ] && [ "$2" = inspect ]; then printf '%s\\n' '${JSON.stringify(remote ? "ssh://production.example" : "unix:///tmp/rehearsal-test-docker.sock")}'; exit 0; fi
if [ "$1" = info ]; then [ -f ${JSON.stringify(ready)} ]; exit; fi
if [ "$1" = ps ]; then printf '${exactIds ? `${"a".repeat(64)}\\n${"b".repeat(64)}\\n` : "owned-one\\nowned-two\\n"}'; exit 0; fi
if [ "$1" = container ] && [ "$2" = inspect ]; then printf '%s\\n' '${JSON.stringify({ "com.supabase.cli.project": "safe-rehearsal", ...(conflictingOwnership ? { "com.rehearsal-db.project": "foreign-rehearsal" } : {}) })}' '{"com.supabase.cli.project":"safe-rehearsal"}'; exit 0; fi
if [ "$1" = update ]; then exit 0; fi
exit 1
`,
    colima: `#!/bin/sh
printf 'colima %s\\n' "$*" >> ${JSON.stringify(log)}
if [ "$1" = version ]; then exit 0; fi
if [ "$1" = list ]; then printf '%s\\n' '{"name":"default","status":"${colimaRunning ? "Running" : "Stopped"}"}'; exit 0; fi
if [ "$1" = start ]; then printf 'ready\\n' > ${JSON.stringify(ready)}; exit 0; fi
exit 1
`,
    supabase: `#!/bin/sh\nprintf 'supabase %s\\n' "$*" >> ${JSON.stringify(log)}\nexit 0\n`,
  };
  for (const [name, source] of Object.entries(commands)) {
    const path = join(root, name);
    await writeFile(path, source);
    await chmod(path, 0o755);
  }
  return {
    root,
    log,
    env: {
      ...process.env,
      PATH: `${root}${delimiter}${process.env.PATH ?? ""}`,
    },
  };
};

const environmentModule = join(
  process.cwd(),
  "dist/src/targets/supabase_environment.mjs",
);

const localStatus = `API_URL=http://127.0.0.1:58321
DB_URL=postgresql://postgres:local-password@127.0.0.1:58322/postgres
PUBLISHABLE_KEY=local-publishable
SERVICE_ROLE_KEY=local-service-role
STUDIO_URL=http://127.0.0.1:58323
`;

describe("local Supabase environment", () => {
  it("keeps safe provider failure evidence without exposing logs or starting an engine", async () => {
    const fake = await fakeCommandEnvironment();
    await writeFile(
      join(fake.root, "supabase"),
      `#!/bin/sh
printf '%s\\n' 'DB_URL=postgresql://owner:private-password@localhost/private' 'private-row-canary' 'supabase_auth_private-project container is not ready: starting' >&2
exit 1
`,
    );
    const source = `import { runLocalCommand } from ${JSON.stringify(environmentModule)};
try { runLocalCommand("supabase", ["start", "--workdir", "/private/candidate-acceptance/runtime"], { capture: true }); }
catch (error) { console.log(error.message); }`;
    const result = await execute(
      process.execPath,
      ["--input-type=module", "--eval", source],
      { env: fake.env },
    );
    expect(result.stdout).toContain("Supabase startup failed (exit 1)");
    expect(result.stdout).toContain("auth=starting");
    for (const canary of [
      "private-password",
      "private-row-canary",
      "private-project",
      "candidate-acceptance",
    ])
      expect(result.stdout).not.toContain(canary);
    expect(result.stderr).toBe("");
    await expect(readFile(fake.log, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each([true, false])(
    "keeps Supabase health truthful on a bound nondefault Docker config (healthy=%s)",
    async (healthy) => {
      const fake = await fakeCommandEnvironment({ dockerReady: true });
      const dockerConfig = join(fake.root, "private-docker-config");
      await mkdir(dockerConfig);
      const endpoint = "unix:///tmp/rehearsal-test-docker.sock";
      // This command never forwards: success requires the exact scoped engine
      // AND an explicitly supplied service key, with ambient credentials absent.
      await writeFile(
        join(fake.root, "supabase"),
        `#!/bin/sh
printf 'supabase %s\\n' "$*" >> ${JSON.stringify(fake.log)}
[ "$DOCKER_CONFIG" = ${JSON.stringify(dockerConfig)} ] || exit 31
[ "$DOCKER_HOST" = ${JSON.stringify(endpoint)} ] || exit 32
[ -z "$DOCKER_CONTEXT" ] || exit 33
[ "$LOCAL_SERVICE_KEY" = allowlisted ] || exit 34
[ -z "$HOSTED_SECRET_CANARY" ] || exit 35
[ "$1" = status ] || exit 36
${healthy ? `printf '%s\\n' '${localStatus}'; exit 0` : "exit 1"}
`,
      );
      const source = `import { ensureLocalContainerRuntime } from ${JSON.stringify(environmentModule)};
import { inspectSupabaseRuntimeStatus } from ${JSON.stringify(join(process.cwd(), "dist/src/targets/supabase_status.mjs"))};
ensureLocalContainerRuntime({ cwd: ${JSON.stringify(fake.root)} });
const status = await inspectSupabaseRuntimeStatus({
 cwd: ${JSON.stringify(fake.root)}, runtimeWorkdir: ${JSON.stringify(fake.root)}, projectId: "safe-rehearsal",
 runtimeMarkerPath: ${JSON.stringify(join(fake.root, "missing-marker.json"))},
 baselineDataSha256: "${"a".repeat(64)}", baselineSchemaSha256: null,
 baselineGenerationId: "20260912T120000Z-aaaaaaaaaaaa", candidateSha256: "${"b".repeat(64)}", candidates: [],
 loadServiceEnvironment: async () => ({ LOCAL_SERVICE_KEY: "allowlisted", DOCKER_HOST: "unix:///foreign.sock", DOCKER_CONFIG: "/foreign" }),
});
console.log(JSON.stringify({state:status.state, reason:status.reason}));`;
      const result = await execute(
        process.execPath,
        ["--input-type=module", "--eval", source],
        {
          env: {
            ...fake.env,
            DOCKER_CONFIG: dockerConfig,
            DOCKER_CONTEXT: "colima",
            DOCKER_HOST: "",
            DOCKER_TLS: "",
            DOCKER_TLS_VERIFY: "",
            DOCKER_CERT_PATH: "",
            HOSTED_SECRET_CANARY: "must-not-leak",
          },
        },
      );
      expect(JSON.parse(result.stdout)).toEqual({
        state: healthy ? "running" : "unhealthy",
        reason: healthy ? null : "health_check_failed",
      });
      expect(result.stderr).toBe("");
      const log = await readFile(fake.log, "utf8");
      expect(log).toContain("supabase status --workdir");
      expect(log).not.toMatch(/(?:supabase|colima) (?:start|stop)/u);
    },
  );

  it("refuses ambient TLS before executing a Supabase health probe", async () => {
    const fake = await fakeCommandEnvironment({ dockerReady: true });
    const source = `import { ensureLocalContainerRuntime, localCommandSucceeds } from ${JSON.stringify(environmentModule)};
ensureLocalContainerRuntime();
localCommandSucceeds("supabase", ["status"]);`;
    await expect(
      execute(process.execPath, ["--input-type=module", "--eval", source], {
        env: { ...fake.env, DOCKER_TLS_VERIFY: "1" },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Explicit selectors were not ignored"),
    });
    await expect(readFile(fake.log, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses a reviewed endpoint identity drift before a Supabase health probe", async () => {
    const fake = await fakeCommandEnvironment({ dockerReady: true });
    const source = `import { bindRuntimeDockerEnvironment } from ${JSON.stringify(join(process.cwd(), "dist/src/runtime/local_docker_context.mjs"))};
import { localCommandSucceeds } from ${JSON.stringify(environmentModule)};
bindRuntimeDockerEnvironment({ expectedIdentity: "${"0".repeat(64)}" });
localCommandSucceeds("supabase", ["status"]);`;
    await expect(
      execute(process.execPath, ["--input-type=module", "--eval", source], {
        env: {
          ...fake.env,
          DOCKER_CONTEXT: "colima",
          DOCKER_HOST: "",
          DOCKER_TLS: "",
          DOCKER_TLS_VERIFY: "",
          DOCKER_CERT_PATH: "",
        },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("reviewed Docker endpoint changed"),
    });
    expect(await readFile(fake.log, "utf8")).not.toContain("supabase");
  });

  it("keeps application and full service profiles explicit", () => {
    expect(supabaseExcludedServicesForProfile("application")).toEqual([
      "edge-runtime",
      "logflare",
      "vector",
      "realtime",
      "studio",
      "imgproxy",
    ]);
    expect(supabaseExcludedServicesForProfile("full")).toEqual([]);
  });
  it("keeps the validated local database connection for package-owned commands", () => {
    expect(parseLocalSupabaseEnvironment(localStatus)).toMatchObject({
      apiUrl: "http://127.0.0.1:58321",
      databaseUrl:
        "postgresql://postgres:local-password@127.0.0.1:58322/postgres",
      databaseHost: "127.0.0.1",
      databasePort: "58322",
      databaseName: "postgres",
      databaseUser: "postgres",
      databasePassword: "local-password",
    });
  });

  it("rejects hosted, incomplete, and non-PostgreSQL status values", () => {
    expect(() =>
      parseLocalSupabaseEnvironment(
        localStatus.replace("127.0.0.1:58322", "db.example.com:5432"),
      ),
    ).toThrow("non-local");
    expect(() =>
      parseLocalSupabaseEnvironment(localStatus.replace(/^DB_URL=.*\n/mu, "")),
    ).toThrow("omitted its database URL");
    expect(() =>
      parseLocalSupabaseEnvironment(
        localStatus.replace("postgresql://", "mysql://"),
      ),
    ).toThrow("non-local");
  });

  it("does not start Colima unless a caller explicitly opts in", async () => {
    const fake = await fakeCommandEnvironment();
    const source = `import { ensureLocalContainerRuntime } from ${JSON.stringify(environmentModule)}; ensureLocalContainerRuntime();`;
    await expect(
      execute(process.execPath, ["--input-type=module", "--eval", source], {
        env: fake.env,
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Start Docker or Colima explicitly"),
    });
    expect(await readFile(fake.log, "utf8")).not.toContain("colima start");
  });

  it("reports an explicit Colima auto-start without changing its settings", async () => {
    const fake = await fakeCommandEnvironment();
    const source = `import { ensureLocalContainerRuntime } from ${JSON.stringify(environmentModule)}; ensureLocalContainerRuntime({ autoStartColima: true });`;
    const result = await execute(
      process.execPath,
      ["--input-type=module", "--eval", source],
      { env: fake.env },
    );
    expect(result.stdout).toContain(
      "Started Colima because containerRuntime.autoStartColima is enabled",
    );
    const log = await readFile(fake.log, "utf8");
    expect(log).toContain("colima start");
    expect(log).not.toMatch(/colima start .+/u);
  });

  it("changes restart policy only for exact Supabase project-label matches", async () => {
    const fake = await fakeCommandEnvironment({ dockerReady: true });
    const previousPath = process.env.PATH;
    const previousLog = process.env.REHEARSAL_TEST_LOG;
    const previousReady = process.env.REHEARSAL_TEST_READY;
    Object.assign(process.env, fake.env);
    try {
      expect(
        preventOwnedSupabaseAutoRestart({ projectId: "safe-rehearsal" }),
      ).toEqual(["owned-one", "owned-two"]);
    } finally {
      process.env.PATH = previousPath;
      if (previousLog === undefined) delete process.env.REHEARSAL_TEST_LOG;
      else process.env.REHEARSAL_TEST_LOG = previousLog;
      if (previousReady === undefined) delete process.env.REHEARSAL_TEST_READY;
      else process.env.REHEARSAL_TEST_READY = previousReady;
    }
    const log = await readFile(fake.log, "utf8");
    expect(log).toContain(
      "docker ps --all --filter label=com.supabase.cli.project=safe-rehearsal --format {{.ID}}",
    );
    expect(log).toContain("docker update --restart=no owned-one owned-two");
    expect(() =>
      preventOwnedSupabaseAutoRestart({ projectId: "../../unsafe" }),
    ).toThrow("exact safe Supabase project id");
  });

  it("refuses remote contexts before any daemon probe or Colima startup", async () => {
    const fake = await fakeCommandEnvironment({ remote: true });
    const source = `import { ensureLocalContainerRuntime } from ${JSON.stringify(environmentModule)}; ensureLocalContainerRuntime({ autoStartColima: true });`;
    await expect(
      execute(process.execPath, ["--input-type=module", "--eval", source], {
        env: fake.env,
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("local Docker endpoint"),
    });
    const log = await readFile(fake.log, "utf8");
    expect(log).not.toContain("docker info");
    expect(log).not.toContain("colima start");
  });

  it("does not claim a manually running Colima VM when Docker is temporarily unavailable", async () => {
    const fake = await fakeCommandEnvironment({ colimaRunning: true });
    const source = `import { ensureLocalContainerRuntime } from ${JSON.stringify(environmentModule)}; ensureLocalContainerRuntime({ autoStartColima: true });`;
    await expect(
      execute(process.execPath, ["--input-type=module", "--eval", source], {
        env: fake.env,
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "cannot prove the default Colima VM is stopped",
      ),
    });
    expect(await readFile(fake.log, "utf8")).not.toContain("colima start");
  });

  it.each([false, true])(
    "ordinary stop rejects ambiguous ownership before Supabase executes (conflict=%s)",
    async (conflict) => {
      const fake = await fakeCommandEnvironment({
        dockerReady: true,
        exactIds: true,
        conflictingOwnership: conflict,
      });
      const workdir = join(fake.root, "runtime");
      await mkdir(join(workdir, "supabase"), { recursive: true });
      await writeFile(
        join(workdir, "supabase/config.toml"),
        'project_id = "safe-rehearsal"\n',
      );
      const source = `import { stopLocalSupabase } from ${JSON.stringify(environmentModule)}; stopLocalSupabase({cwd:${JSON.stringify(fake.root)},workdir:${JSON.stringify(workdir)},projectId:"safe-rehearsal"});`;
      if (conflict) {
        await expect(
          execute(process.execPath, ["--input-type=module", "--eval", source], {
            env: fake.env,
          }),
        ).rejects.toMatchObject({
          stderr: expect.stringContaining("conflicting"),
        });
        expect(await readFile(fake.log, "utf8")).not.toContain("supabase stop");
      } else {
        await execute(
          process.execPath,
          ["--input-type=module", "--eval", source],
          { env: fake.env },
        );
        expect(await readFile(fake.log, "utf8")).toContain(
          `supabase stop --workdir ${workdir}`,
        );
      }
    },
  );

  it("refuses changed workdir identity without stopping another project", async () => {
    const fake = await fakeCommandEnvironment({
      dockerReady: true,
      exactIds: true,
    });
    const workdir = join(fake.root, "runtime");
    await mkdir(join(workdir, "supabase"), { recursive: true });
    await writeFile(
      join(workdir, "supabase/config.toml"),
      'project_id = "other-rehearsal"\n',
    );
    const source = `import { stopLocalSupabase } from ${JSON.stringify(environmentModule)}; stopLocalSupabase({cwd:${JSON.stringify(fake.root)},workdir:${JSON.stringify(workdir)},projectId:"safe-rehearsal"});`;
    await expect(
      execute(process.execPath, ["--input-type=module", "--eval", source], {
        env: fake.env,
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("workdir identity differs"),
    });
    expect(await readFile(fake.log, "utf8")).not.toContain("supabase stop");
  });
});
