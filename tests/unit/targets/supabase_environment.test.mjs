import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseLocalSupabaseEnvironment,
  preventOwnedSupabaseAutoRestart,
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

const fakeCommandEnvironment = async ({ dockerReady = false } = {}) => {
  const root = await mkdtemp(join(tmpdir(), "rehearsal-runtime-test-"));
  temporaryRoots.push(root);
  const log = join(root, "commands.log");
  const ready = join(root, "docker-ready");
  if (dockerReady) await writeFile(ready, "ready\n");
  const commands = {
    docker: `#!/bin/sh
printf 'docker %s\\n' "$*" >> ${JSON.stringify(log)}
if [ "$1" = info ]; then [ -f ${JSON.stringify(ready)} ]; exit; fi
if [ "$1" = ps ]; then printf 'owned-one\\nowned-two\\n'; exit 0; fi
if [ "$1" = update ]; then exit 0; fi
exit 1
`,
    colima: `#!/bin/sh
printf 'colima %s\\n' "$*" >> ${JSON.stringify(log)}
if [ "$1" = version ]; then exit 0; fi
if [ "$1" = start ]; then printf 'ready\\n' > ${JSON.stringify(ready)}; exit 0; fi
exit 1
`,
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
});
