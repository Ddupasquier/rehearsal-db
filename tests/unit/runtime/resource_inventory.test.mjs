import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertContainerCapacityForRuntime,
  inspectRehearsalResources,
  parseDockerMemoryBytes,
  parseDockerSizeBytes,
  parsePosixDiskUsage,
} from "../../../dist/src/runtime/resource_inventory.mjs";

const roots = [];

const makeProject = async () => {
  const root = await mkdtemp(join(tmpdir(), "rehearsal-inventory-test-"));
  roots.push(root);
  await mkdir(join(root, "database/migrations"), { recursive: true });
  await writeFile(
    join(root, "rehearsal.config.mjs"),
    `export default {
      schemaVersion: 1,
      project: { name: "inventory-test" },
      postgresql: { migrationDirectory: "database/migrations" },
      baseline: { sanitizationPolicy: "rehearsal/policy.json" },
      lifecycle: { run: "stop-after-run" },
      application: { startCommand: "npm run dev", proofCommand: "npm test" },
      runtime: { target: "postgresql", projectId: "inventory-rehearsal", databasePort: 58322 },
      safety: { hostedAccess: "disabled", outboundNetwork: "deny" },
    };\n`,
  );
  return root;
};

const result = (status, stdout = "") => ({
  status,
  stdout,
  stderr: "",
  pid: 1,
  output: [null, stdout, ""],
  signal: null,
  error: undefined,
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

// Existing synthetic local engine metadata; no real Docker command is used.
const localContextResult = (args, context) =>
  result(
    0,
    args[1] === "show"
      ? context
      : args.includes(
            "{{if or .TLSMaterial .Endpoints.docker.SkipTLSVerify}}true{{else}}false{{end}}",
          )
        ? "false"
        : JSON.stringify("unix:///tmp/local-docker.sock"),
  );
describe("resource inventory", () => {
  it("reports only exact configured ownership without starting Docker", async () => {
    const projectRoot = await makeProject();
    const calls = [];
    const run = (command, args) => {
      calls.push([command, ...args]);
      if (command === "docker" && args[0] === "info") return result(0);
      if (command === "docker" && args[0] === "context")
        return localContextResult(args, "colima");
      if (command === "colima") {
        return result(
          0,
          "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vdb1 104857600 83886080 20971520 80% /var/lib/docker\n",
        );
      }
      if (command === "docker" && args[0] === "container" && args[1] === "ls")
        return result(0, "owned\nforeign\n");
      if (
        command === "docker" &&
        args[0] === "container" &&
        args[1] === "inspect"
      ) {
        return result(
          0,
          JSON.stringify([
            {
              Id: "owned",
              Created: "2026-10-10T12:00:00Z",
              Config: {
                Labels: { "com.rehearsal-db.project": "inventory-rehearsal" },
              },
              HostConfig: { RestartPolicy: { Name: "no" } },
              State: { Running: false },
            },
            {
              Id: "foreign",
              Created: "2026-10-11T12:00:00Z",
              Config: {
                Labels: { "com.rehearsal-db.project": "another-project" },
              },
              HostConfig: { RestartPolicy: { Name: "always" } },
              State: { Running: true },
            },
          ]),
        );
      }
      if (command === "docker" && args[0] === "volume" && args[1] === "ls")
        return result(0, "owned-volume\nforeign-volume\n");
      if (command === "docker" && args[0] === "stats") {
        expect(args.at(-1)).toBe("owned");
        expect(args).not.toContain("foreign");
        return result(
          0,
          '{"Container":"owned","CPUPerc":"2.50%","MemUsage":"128MiB / 2GiB"}\n',
        );
      }
      if (
        command === "docker" &&
        args[0] === "volume" &&
        args[1] === "inspect"
      ) {
        return result(
          0,
          JSON.stringify([
            {
              Name: "owned-volume",
              CreatedAt: "2026-10-09T12:00:00Z",
              Labels: {
                "com.rehearsal-db.project": "inventory-rehearsal",
              },
            },
            {
              Name: "foreign-volume",
              CreatedAt: "2026-10-11T12:00:00Z",
              Labels: { "com.rehearsal-db.project": "another-project" },
            },
          ]),
        );
      }
      if (
        command === "docker" &&
        args[0] === "system" &&
        args.includes("--verbose")
      ) {
        return result(
          0,
          JSON.stringify({
            Volumes: [
              { Name: "owned-volume", Size: "1.5GB" },
              { Name: "foreign-volume", Size: "7GB" },
            ],
          }),
        );
      }
      if (command === "docker" && args[0] === "system") {
        return result(
          0,
          '{"Type":"Images","TotalCount":"10","Active":"2","Size":"5GB","Reclaimable":"3GB (60%)"}\n',
        );
      }
      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    };

    const inventory = await inspectRehearsalResources(
      { projectRoot },
      { run, now: () => new Date("2026-10-12T00:00:00Z") },
    );

    expect(inventory).toMatchObject({
      schemaVersion: 1,
      engine: {
        state: "running",
        context: "colima",
        disk: { usedPercent: 80 },
      },
      environments: [
        {
          projectId: "inventory-rehearsal",
          state: "stopped",
          containerCount: 1,
          volumeCount: 1,
          diskUsageBytes: 1_500_000_000,
          cpuPercent: null,
          memoryUsageBytes: null,
          memoryLimitBytes: null,
          cleanupEligibility: "preview-required",
          retention: "persistent",
          classification: {
            role: "configured-environment",
            dataPersistence: "preserved-on-stop",
            presence: { state: "created" },
            receipt: { state: "unknown", reason: "receipt-unavailable" },
            review: { state: "disabled" },
          },
        },
      ],
      stale: { stoppedCount: 1, targets: ["primary"] },
    });
    expect(inventory.stale.digest).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      calls.some(
        ([command, action]) => command === "docker" && action === "start",
      ),
    ).toBe(false);
  });

  it("reports a stopped engine without attempting to start it", async () => {
    const projectRoot = await makeProject();
    const calls = [];
    const inventory = await inspectRehearsalResources(
      { projectRoot },
      {
        run: (command, args) => {
          calls.push([command, ...args]);
          if (args[0] === "context") return localContextResult(args, "colima");
          return result(1);
        },
      },
    );
    expect(inventory.engine).toMatchObject({
      state: "stopped",
      context: "colima",
    });
    expect(inventory.environments[0]).toMatchObject({
      state: "unavailable",
      containerCount: 0,
      cleanupEligibility: "inspection-unavailable",
      retention: "persistent",
      classification: {
        presence: { state: "unknown" },
        review: {
          state: "unknown",
          reason: "ownership-inspection-unavailable",
        },
      },
      provenance: {
        schemaVersion: 1,
        verification: "recorded-not-reverified",
        runtime: null,
        runtimeReason: "receipt-unavailable",
        configuredPorts: [
          { service: "database", host: "127.0.0.1", port: 58322 },
          { service: "application", host: "localhost", port: 5175 },
        ],
      },
    });
    expect(calls).toEqual([
      ["docker", "context", "show"],
      [
        "docker",
        "context",
        "inspect",
        "--format",
        "{{json .Endpoints.docker.Host}}",
        expect.any(String),
      ],
      [
        "docker",
        "context",
        "inspect",
        "--format",
        "{{if or .TLSMaterial .Endpoints.docker.SkipTLSVerify}}true{{else}}false{{end}}",
        expect.any(String),
      ],
      ["docker", "info"],
    ]);
  });
  it("keeps the detailed catalog unknown on a stopped engine and never starts services", async () => {
    const projectRoot = await makeProject();
    const calls = [];
    const inventory = await inspectRehearsalResources(
      { projectRoot },
      {
        includeDetails: true,
        run: (command, args) => {
          calls.push([command, ...args]);
          if (args[0] === "context" && args[1] === "show")
            return localContextResult(args, "colima");
          if (args[0] === "context" && args[1] === "inspect")
            return result(
              0,
              args.includes(
                "{{if or .TLSMaterial .Endpoints.docker.SkipTLSVerify}}true{{else}}false{{end}}",
              )
                ? "false"
                : JSON.stringify("unix:///tmp/local-docker.sock"),
            );
          return result(1);
        },
      },
    );
    expect(inventory.catalog).toBeNull();
    expect(inventory.engine.state).toBe("stopped");
    expect(inventory.environments[0].state).toBe("unavailable");
    expect(
      calls.every(([, action]) => ["context", "info"].includes(action)),
    ).toBe(true);
  });

  it("keeps same-label configured providers' provenance isolated when the engine is unavailable", async () => {
    const projectRoot = await makeProject();
    const configPath = join(projectRoot, "rehearsal.config.mjs");
    await writeFile(
      configPath,
      (await readFile(configPath, "utf8")).replace(
        "runtime: { target:",
        'dependentTargets: [{ name: "publication", configPath: "publication.config.mjs" }], runtime: { displayName: "Same friendly label", target:',
      ),
    );
    await writeFile(
      join(projectRoot, "publication.config.mjs"),
      `export default {
      schemaVersion: 1, project: { name: "publication" },
      supabase: { workdir: "supabase", migrationDirectory: "database/migrations", rehearsalConfig: "rehearsal/config.toml", runtimeWorkdir: "publication/.rehearsal/runtime" },
      baseline: { artifactDirectory: "publication/.rehearsal", sanitizationPolicy: "rehearsal/policy.json" },
      application: { startCommand: "npm run dev", proofCommand: "npm test", environmentFile: "publication/.rehearsal/runtime.env" },
      runtime: { displayName: "Same friendly label", target: "supabase", projectId: "inventory-publication", apiPort: 58421, databasePort: 58422, studioPort: 58423 }
    };`,
    );
    for (const [path, target, generationId, dataSha256] of [
      [
        ".rehearsal/runtime",
        "postgresql",
        "20261015T120000Z-aaaaaaaaaaaa",
        "a".repeat(64),
      ],
      [
        "publication/.rehearsal/runtime",
        "supabase",
        "20261015T120001Z-bbbbbbbbbbbb",
        "b".repeat(64),
      ],
    ]) {
      await mkdir(join(projectRoot, path), { recursive: true });
      await writeFile(
        join(projectRoot, path, "baseline.json"),
        JSON.stringify({
          formatVersion: 1,
          target,
          generationId,
          dataSha256,
          databasePassword: "PRIVATE-CANARY",
        }),
      );
    }
    const calls = [];
    const inventory = await inspectRehearsalResources(
      { projectRoot },
      {
        run: (command, args) => {
          calls.push([command, ...args]);
          return args[0] === "context"
            ? localContextResult(args, "default")
            : result(1);
        },
      },
    );
    expect(
      inventory.environments.map((entry) => ({
        target: entry.target,
        name: entry.displayName,
        provider: entry.provider,
        generation: entry.provenance.runtime.baselineGenerationId,
      })),
    ).toEqual([
      {
        target: "primary",
        name: "Same friendly label",
        provider: "postgresql",
        generation: "20261015T120000Z-aaaaaaaaaaaa",
      },
      {
        target: "publication",
        name: "Same friendly label",
        provider: "supabase",
        generation: "20261015T120001Z-bbbbbbbbbbbb",
      },
    ]);
    expect(
      inventory.environments.every((entry) => entry.state === "unavailable"),
    ).toBe(true);
    expect(JSON.stringify(inventory)).not.toContain("PRIVATE-CANARY");
    expect(calls).toEqual([
      ["docker", "context", "show"],
      [
        "docker",
        "context",
        "inspect",
        "--format",
        "{{json .Endpoints.docker.Host}}",
        expect.any(String),
      ],
      [
        "docker",
        "context",
        "inspect",
        "--format",
        "{{if or .TLSMaterial .Endpoints.docker.SkipTLSVerify}}true{{else}}false{{end}}",
        expect.any(String),
      ],
      ["docker", "info"],
    ]);
  });

  it("reports bounded live CPU and memory only for verified running containers", async () => {
    const projectRoot = await makeProject();
    const inventory = await inspectRehearsalResources(
      { projectRoot },
      {
        run: (command, args) => {
          if (command === "docker" && args[0] === "info") return result(0);
          if (command === "docker" && args[0] === "context")
            return localContextResult(args, "default");
          if (
            command === "docker" &&
            args[0] === "container" &&
            args[1] === "ls"
          )
            return result(0, "one\ntwo\n");
          if (
            command === "docker" &&
            args[0] === "container" &&
            args[1] === "inspect"
          ) {
            return result(
              0,
              JSON.stringify([
                {
                  Id: "one",
                  Config: {
                    Labels: {
                      "com.rehearsal-db.project": "inventory-rehearsal",
                    },
                  },
                  HostConfig: { RestartPolicy: { Name: "no" } },
                  State: { Running: true, StartedAt: "2026-10-12T00:00:00Z" },
                },
                {
                  Id: "two",
                  Config: {
                    Labels: {
                      "com.rehearsal-db.project": "inventory-rehearsal",
                    },
                  },
                  HostConfig: { RestartPolicy: { Name: "no" } },
                  State: { Running: true, StartedAt: "2026-10-12T00:00:01Z" },
                },
              ]),
            );
          }
          if (command === "docker" && args[0] === "stats") {
            expect(args.slice(-2)).toEqual(["one", "two"]);
            return result(
              0,
              [
                '{"Container":"one","CPUPerc":"1.25%","MemUsage":"128MiB / 2GiB"}',
                '{"Container":"two","CPUPerc":"2.75%","MemUsage":"64MiB / 2GiB"}',
              ].join("\n"),
            );
          }
          if (command === "docker" && args[0] === "volume" && args[1] === "ls")
            return result(0);
          if (
            command === "docker" &&
            args[0] === "system" &&
            args.includes("--verbose")
          )
            return result(0, JSON.stringify({ Volumes: [] }));
          if (command === "docker" && args[0] === "system") return result(0);
          throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
        },
      },
    );
    expect(inventory.environments[0]).toMatchObject({
      state: "running",
      cpuPercent: 4,
      memoryUsageBytes: 192 * 1024 ** 2,
      memoryLimitBytes: 4 * 1024 ** 3,
    });
  });
  it("reports unknown CPU rather than zero when live sampling fails", async () => {
    const projectRoot = await makeProject();
    const inventory = await inspectRehearsalResources(
      { projectRoot },
      {
        run: (_command, args) => {
          if (args[0] === "context") return localContextResult(args, "default");
          if (args[0] === "container" && args[1] === "ls")
            return result(0, "one\n");
          if (args[0] === "container" && args[1] === "inspect")
            return result(
              0,
              JSON.stringify([
                {
                  Id: "one",
                  Config: {
                    Labels: {
                      "com.rehearsal-db.project": "inventory-rehearsal",
                    },
                  },
                  State: { Running: true },
                },
              ]),
            );
          if (args[0] === "stats") return result(1);
          return result(0);
        },
      },
    );
    expect(inventory.environments[0]).toMatchObject({
      state: "running",
      cpuPercent: null,
      memoryUsageBytes: null,
    });
  });

  it("does not treat helper-looking names or extra retention labels as disposable ownership", async () => {
    const projectRoot = await makeProject();
    const calls = [];
    const inventory = await inspectRehearsalResources(
      { projectRoot },
      {
        run: (command, args) => {
          calls.push([command, ...args]);
          if (args[0] === "info") return result(0);
          if (args[0] === "context") return localContextResult(args, "default");
          if (args[0] === "container" && args[1] === "ls")
            return result(0, "owned\nforeign-helper\nunlabeled-helper\n");
          if (args[0] === "container" && args[1] === "inspect")
            return result(
              0,
              JSON.stringify([
                {
                  Id: "owned",
                  Name: "/inventory-rehearsal-temporary-helper",
                  Config: {
                    Labels: {
                      "com.rehearsal-db.project": "inventory-rehearsal",
                      // These extra labels are untrusted fixture data, not a helper API.
                      "com.rehearsal-db.role": "helper",
                      "com.rehearsal-db.retention": "disposable",
                    },
                  },
                  State: { Running: false },
                },
                {
                  Id: "foreign-helper",
                  Name: "/inventory-rehearsal-helper",
                  Config: {
                    Labels: { "com.rehearsal-db.project": "other-project" },
                  },
                  State: { Running: false },
                },
                {
                  Id: "unlabeled-helper",
                  Name: "/inventory-rehearsal-disposable",
                  Config: { Labels: {} },
                  State: { Running: false },
                },
              ]),
            );
          if (args[0] === "volume" && args[1] === "ls") return result(0);
          if (args[0] === "system") return result(0);
          throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
        },
      },
    );
    expect(inventory.environments).toHaveLength(1);
    expect(inventory.environments[0]).toMatchObject({
      projectId: "inventory-rehearsal",
      state: "stopped",
      containerCount: 1,
      retention: "persistent",
      cleanupEligibility: "preview-required",
      classification: {
        role: "configured-environment",
        dataPersistence: "preserved-on-stop",
        presence: { state: "created" },
      },
    });
    expect(
      calls.every(
        ([command, ...args]) =>
          command === "docker" &&
          [
            "info",
            "context show",
            "context inspect",
            "container ls",
            "container inspect",
            "volume ls",
            "volume inspect",
            "system df",
          ].includes(args.slice(0, 2).join(" ")),
      ),
    ).toBe(true);
  });

  it("fails closed when recognized ownership labels conflict, even with helper labels", async () => {
    const projectRoot = await makeProject();
    const inventory = await inspectRehearsalResources(
      { projectRoot },
      {
        run: (command, args) => {
          if (command === "docker" && args[0] === "info") return result(0);
          if (command === "docker" && args[0] === "context")
            return localContextResult(args, "default");
          if (
            command === "docker" &&
            args[0] === "container" &&
            args[1] === "ls"
          )
            return result(0, "conflict\n");
          if (
            command === "docker" &&
            args[0] === "container" &&
            args[1] === "inspect"
          ) {
            return result(
              0,
              JSON.stringify([
                {
                  Id: "conflict",
                  Config: {
                    Labels: {
                      "com.rehearsal-db.project": "inventory-rehearsal",
                      "com.supabase.cli.project": "another-project",
                      "com.rehearsal-db.role": "helper",
                      "com.rehearsal-db.retention": "disposable",
                    },
                  },
                  State: { Running: true },
                },
              ]),
            );
          }
          if (command === "docker" && args[0] === "volume" && args[1] === "ls")
            return result(0);
          if (
            command === "docker" &&
            args[0] === "system" &&
            args.includes("--verbose")
          )
            return result(0, JSON.stringify({ Volumes: [] }));
          if (command === "docker" && args[0] === "system") return result(0);
          throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
        },
      },
    );
    expect(inventory.environments[0]).toMatchObject({
      state: "unavailable",
      containerCount: 0,
      cleanupEligibility: "inspection-unavailable",
      retention: "persistent",
      classification: {
        presence: { state: "unknown" },
        review: { state: "unknown" },
      },
    });
  });

  it("refuses startup below configured headroom and warns at the threshold", () => {
    const df =
      "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vdb1 41943040 37748736 2097152 90% /var/lib/docker\n";
    const run = (command, args) =>
      command === "docker" && args[0] === "context"
        ? localContextResult(args, "colima")
        : result(0, df);
    expect(() =>
      assertContainerCapacityForRuntime({
        warningPercent: 80,
        minimumFreeBytes: 8 * 1024 ** 3,
        run,
      }),
    ).toThrow("requires at least 8.0 GiB");
    expect(
      assertContainerCapacityForRuntime({
        warningPercent: 80,
        minimumFreeBytes: 1024 ** 3,
        run,
      }).warning,
    ).toContain("90%");
  });

  it("parses portable POSIX disk output", () => {
    expect(
      parsePosixDiskUsage("x\n/dev/vdb1 100 75 25 75% /var/lib/docker\n"),
    ).toEqual({
      totalBytes: 102400,
      usedBytes: 76800,
      availableBytes: 25600,
      usedPercent: 75,
    });
  });

  it("parses Docker's decimal resource sizes", () => {
    expect(parseDockerSizeBytes("693B")).toBe(693);
    expect(parseDockerSizeBytes("40.5MB")).toBe(40_500_000);
    expect(parseDockerSizeBytes("1.964GB")).toBe(1_964_000_000);
    expect(parseDockerSizeBytes("unknown")).toBeNull();
  });

  it("parses Docker's binary live-memory sizes", () => {
    expect(parseDockerMemoryBytes("128MiB")).toBe(128 * 1024 ** 2);
    expect(parseDockerMemoryBytes("2 GiB")).toBe(2 * 1024 ** 3);
    expect(parseDockerMemoryBytes("unknown")).toBeNull();
  });
});
