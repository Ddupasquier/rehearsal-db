import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTAINER_ENGINE_RECEIPT_FILENAME,
  readValidContainerEngineStartReceipt,
  releaseOwnedColimaWhenIdle,
  writeContainerEngineStartReceipt,
} from "../../../../dist/src/runtime/engines/container_engine_ownership.mjs";

const roots = [];
const bootId = "29b0d91d-91a7-4a5b-95f7-fd2d5dbdd388";
const result = (status, stdout = "") => ({
  status,
  stdout,
  stderr: "",
  pid: 1,
  output: [null, stdout, ""],
  signal: null,
  error: undefined,
});

const engineIdentityRun =
  (calls = []) =>
  (command, args) => {
    calls.push([command, ...args]);
    if (
      command === "docker" &&
      args[0] === "context" &&
      args.includes(
        "{{if or .TLSMaterial .Endpoints.docker.SkipTLSVerify}}true{{else}}false{{end}}",
      )
    )
      return result(0, "false");
    if (command === "docker" && args[0] === "context" && args[1] === "inspect")
      return result(
        0,
        JSON.stringify("unix:///tmp/rehearsal-colima-test.sock"),
      );
    if (
      command === "docker" &&
      args[0] === "context" &&
      args.includes(
        "{{if or .TLSMaterial .Endpoints.docker.SkipTLSVerify}}true{{else}}false{{end}}",
      )
    )
      return result(0, "false");
    if (command === "docker" && args[0] === "context")
      return result(0, "colima\n");
    if (command === "colima" && args[0] === "ssh")
      return result(0, `${bootId}\n`);
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  };

const makeInput = async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "rehearsal-engine-owner-"));
  roots.push(projectRoot);
  return {
    path: join(projectRoot, ".rehearsal", CONTAINER_ENGINE_RECEIPT_FILENAME),
    projectRoot,
    projectId: "engine-owner-rehearsal",
    operationId: "e5df9843-f21d-4305-8ef8-497ac52f530f",
  };
};

const targetFor = (input, enabled = true) => ({
  paths: { artifactDirectory: join(input.projectRoot, ".rehearsal") },
  config: {
    runtime: { projectId: input.projectId },
    containerRuntime: { stopOwnedColimaWhenIdle: enabled },
  },
});

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("container engine ownership", () => {
  it("writes an owner-only receipt bound to the current Colima boot", async () => {
    const input = await makeInput();
    writeContainerEngineStartReceipt({
      input,
      run: engineIdentityRun(),
      now: () => new Date("2026-10-13T12:00:00Z"),
    });
    const stored = JSON.parse(await readFile(input.path, "utf8"));
    expect(stored).toMatchObject({
      schemaVersion: 1,
      engine: "colima",
      context: "colima",
      bootId,
      projectId: input.projectId,
      operationId: input.operationId,
      createdAt: "2026-10-13T12:00:00.000Z",
    });
    expect(
      readValidContainerEngineStartReceipt({
        input,
        run: engineIdentityRun(),
      }),
    ).toMatchObject({ bootId, projectId: input.projectId });
  });

  it("rejects a receipt that is not owner-only", async () => {
    const input = await makeInput();
    writeContainerEngineStartReceipt({ input, run: engineIdentityRun() });
    await chmod(input.path, 0o644);
    expect(
      readValidContainerEngineStartReceipt({
        input,
        run: engineIdentityRun(),
      }),
    ).toBeNull();
  });

  it("stops only the same idle Colima boot and retires its receipt", async () => {
    const input = await makeInput();
    writeContainerEngineStartReceipt({ input, run: engineIdentityRun() });
    const calls = [];
    const release = await releaseOwnedColimaWhenIdle({
      projectRoot: input.projectRoot,
      targets: [targetFor(input)],
      dependencies: {
        qualify: async (_options, endpoint, daemonId) => ({
          endpoint,
          daemonId,
          bootId,
          environment: {},
        }),
        confirm: async () => ({ profileStopped: true, vmProcessAbsent: true }),
      },
      run: (command, args) => {
        calls.push([command, ...args]);
        if (command === "docker" && args[0] === "info")
          return result(0, "synthetic-daemon");
        if (
          command === "docker" &&
          args[0] === "context" &&
          args.includes(
            "{{if or .TLSMaterial .Endpoints.docker.SkipTLSVerify}}true{{else}}false{{end}}",
          )
        )
          return result(0, "false");
        if (
          command === "docker" &&
          args[0] === "context" &&
          args[1] === "inspect"
        )
          return result(
            0,
            JSON.stringify("unix:///tmp/rehearsal-colima-test.sock"),
          );
        if (
          command === "docker" &&
          args[0] === "context" &&
          args.includes(
            "{{if or .TLSMaterial .Endpoints.docker.SkipTLSVerify}}true{{else}}false{{end}}",
          )
        )
          return result(0, "false");
        if (command === "docker" && args[0] === "context")
          return result(0, "colima\n");
        if (command === "docker" && args[0] === "container")
          return result(0, "");
        if (command === "colima" && args[0] === "ssh")
          return result(0, `${bootId}\n`);
        if (command === "colima" && args[0] === "stop") return result(0);
        throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
      },
    });
    expect(release.state).toBe("stopped");
    expect(calls).toContainEqual(["colima", "stop"]);
    expect(
      readValidContainerEngineStartReceipt({
        input,
        run: engineIdentityRun(),
      }),
    ).toBeNull();
  });

  it("preserves Colima when another container is running", async () => {
    const input = await makeInput();
    writeContainerEngineStartReceipt({ input, run: engineIdentityRun() });
    const calls = [];
    const release = await releaseOwnedColimaWhenIdle({
      projectRoot: input.projectRoot,
      targets: [targetFor(input)],
      run: (command, args) => {
        calls.push([command, ...args]);
        if (command === "docker" && args[0] === "info") return result(0);
        if (
          command === "docker" &&
          args[0] === "context" &&
          args.includes(
            "{{if or .TLSMaterial .Endpoints.docker.SkipTLSVerify}}true{{else}}false{{end}}",
          )
        )
          return result(0, "false");
        if (
          command === "docker" &&
          args[0] === "context" &&
          args[1] === "inspect"
        )
          return result(
            0,
            JSON.stringify("unix:///tmp/rehearsal-colima-test.sock"),
          );
        if (
          command === "docker" &&
          args[0] === "context" &&
          args.includes(
            "{{if or .TLSMaterial .Endpoints.docker.SkipTLSVerify}}true{{else}}false{{end}}",
          )
        )
          return result(0, "false");
        if (command === "docker" && args[0] === "context")
          return result(0, "colima\n");
        if (command === "docker" && args[0] === "container")
          return result(0, "foreign-container\n");
        if (command === "colima" && args[0] === "ssh")
          return result(0, `${bootId}\n`);
        throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
      },
    });
    expect(release).toMatchObject({ state: "preserved" });
    expect(release.message).toContain("1 other running container remains");
    expect(calls).not.toContainEqual(["colima", "stop"]);
  });

  it("preserves manually started engines and requires every target to opt in", async () => {
    const input = await makeInput();
    const noReceipt = await releaseOwnedColimaWhenIdle({
      projectRoot: input.projectRoot,
      targets: [targetFor(input)],
      run: (command, args) => {
        if (command === "docker" && args[0] === "info") return result(0);
        if (
          command === "docker" &&
          args[0] === "context" &&
          args.includes(
            "{{if or .TLSMaterial .Endpoints.docker.SkipTLSVerify}}true{{else}}false{{end}}",
          )
        )
          return result(0, "false");
        if (
          command === "docker" &&
          args[0] === "context" &&
          args[1] === "inspect"
        )
          return result(
            0,
            JSON.stringify("unix:///tmp/rehearsal-colima-test.sock"),
          );
        if (
          command === "docker" &&
          args[0] === "context" &&
          args.includes(
            "{{if or .TLSMaterial .Endpoints.docker.SkipTLSVerify}}true{{else}}false{{end}}",
          )
        )
          return result(0, "false");
        if (command === "docker" && args[0] === "context")
          return result(0, "colima\n");
        if (command === "colima" && args[0] === "ssh")
          return result(0, `${bootId}\n`);
        throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
      },
    });
    expect(noReceipt.message).toContain("no current owner-only receipt");

    expect(
      (
        await releaseOwnedColimaWhenIdle({
          projectRoot: input.projectRoot,
          targets: [targetFor(input), targetFor(input, false)],
          run: () => {
            throw new Error("Disabled policy must not inspect the engine.");
          },
        })
      ).state,
    ).toBe("disabled");
  });

  it("refuses remote endpoints even when their context is named colima", async () => {
    const input = await makeInput();
    const calls = [];
    const run = (command, args) => {
      calls.push([command, ...args]);
      if (
        command === "docker" &&
        args[0] === "context" &&
        args.includes(
          "{{if or .TLSMaterial .Endpoints.docker.SkipTLSVerify}}true{{else}}false{{end}}",
        )
      )
        return result(0, "false");
      if (
        command === "docker" &&
        args[0] === "context" &&
        args[1] === "inspect"
      )
        return result(0, JSON.stringify("ssh://production.example"));
      if (
        command === "docker" &&
        args[0] === "context" &&
        args.includes(
          "{{if or .TLSMaterial .Endpoints.docker.SkipTLSVerify}}true{{else}}false{{end}}",
        )
      )
        return result(0, "false");
      if (command === "docker" && args[0] === "context")
        return result(0, "colima\n");
      if (command === "docker" && args[0] === "info") return result(0);
      throw new Error("A remote context must never reach Colima or mutation.");
    };
    expect(() => writeContainerEngineStartReceipt({ input, run })).toThrow(
      "could not bind",
    );
    expect(
      (
        await releaseOwnedColimaWhenIdle({
          projectRoot: input.projectRoot,
          targets: [targetFor(input)],
          run,
        })
      ).state,
    ).toBe("preserved");
    expect(calls.filter(([command]) => command === "colima")).toEqual([]);
  });

  it("preserves engines when the same context changes its endpoint or boot", async () => {
    const input = await makeInput();
    writeContainerEngineStartReceipt({ input, run: engineIdentityRun() });
    const changed = (changeBoot) => (command, args) => {
      if (
        command === "docker" &&
        args[0] === "context" &&
        args.includes(
          "{{if or .TLSMaterial .Endpoints.docker.SkipTLSVerify}}true{{else}}false{{end}}",
        )
      )
        return result(0, "false");
      if (
        command === "docker" &&
        args[0] === "context" &&
        args[1] === "inspect"
      )
        return result(
          0,
          JSON.stringify(
            changeBoot
              ? "unix:///tmp/rehearsal-colima-test.sock"
              : "unix:///tmp/different-colima.sock",
          ),
        );
      if (
        command === "docker" &&
        args[0] === "context" &&
        args.includes(
          "{{if or .TLSMaterial .Endpoints.docker.SkipTLSVerify}}true{{else}}false{{end}}",
        )
      )
        return result(0, "false");
      if (command === "docker" && args[0] === "context")
        return result(0, "colima\n");
      if (command === "colima" && args[0] === "ssh")
        return result(
          0,
          changeBoot ? "11111111-1111-1111-1111-111111111111" : bootId,
        );
      throw new Error("No mutation is allowed.");
    };
    expect(
      readValidContainerEngineStartReceipt({ input, run: changed(false) }),
    ).toBeNull();
    expect(
      readValidContainerEngineStartReceipt({ input, run: changed(true) }),
    ).toBeNull();
  });
});
