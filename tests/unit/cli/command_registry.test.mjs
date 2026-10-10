import { performance } from "node:perf_hooks";
import { describe, expect, it, vi } from "vitest";
import packageMetadata from "../../../package.json" with { type: "json" };
import { parseArguments } from "../../../dist/src/cli/arguments.mjs";
import { createApplicationCommandHandlers } from "../../../dist/src/cli/application_command_handlers.mjs";
import { createBasicCommandHandlers } from "../../../dist/src/cli/basic_command_handlers.mjs";
import {
  createCliSessionState,
  exactCommands,
  renderedCommand,
  textCommand,
} from "../../../dist/src/cli/command_contract.mjs";
import { createCommandEmitter } from "../../../dist/src/cli/command_output.mjs";
import { createCommandRegistry } from "../../../dist/src/cli/command_registry.mjs";

const context = (command, arguments_ = []) => ({
  command,
  flags: parseArguments(arguments_).flags,
  planOptions: { projectRoot: "/tmp/rehearsal-command-test" },
  guided: false,
  state: createCliSessionState(),
});

describe("typed CLI command registry", () => {
  it("dispatches the first matching handler and reports unknown commands", async () => {
    const registry = createCommandRegistry([
      exactCommands("status", ["status"], async () => textCommand("ready")),
      exactCommands("other", ["other"], async () => textCommand("other")),
    ]);

    await expect(registry.execute(context("status"))).resolves.toEqual({
      kind: "text",
      output: "ready",
    });
    await expect(registry.execute(context("missing"))).resolves.toBeNull();
    expect(registry.ids).toEqual(["status", "other"]);
  });

  it("rejects duplicate handler IDs during registry construction", () => {
    const handler = exactCommands("duplicate", ["one"], async () =>
      textCommand("one"),
    );
    expect(() => createCommandRegistry([handler, handler])).toThrow(
      "CLI command registry IDs must be unique.",
    );
  });

  it("keeps version and help behavior directly testable", async () => {
    const registry = createCommandRegistry(createBasicCommandHandlers());
    const version = await registry.execute(
      context("ignored", ["--version", "--json"]),
    );
    expect(version?.kind).toBe("text");
    expect(JSON.parse(version.output)).toMatchObject({
      name: "@rehearsal-db/core",
      version: packageMetadata.version,
    });

    const help = await registry.execute(context("help"));
    expect(help).toMatchObject({ kind: "text" });
    expect(help.output).toContain("Usage: rehearsal <command> [options]");
  });

  it("emits one stable JSON envelope for typed rendered results", () => {
    const output = [];
    const emit = createCommandEmitter({
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
      startedMs: performance.now(),
      write: (line) => output.push(line),
    });
    const flags = parseArguments(["--json"]).flags;
    const exitCode = emit({
      command: "doctor",
      flags,
      result: renderedCommand({
        data: { state: "READY" },
        render: () => "READY",
      }),
    });

    expect(exitCode).toBeUndefined();
    expect(JSON.parse(output[0])).toMatchObject({
      command: "doctor",
      status: "success",
      data: { state: "READY" },
    });
  });

  it("unit-tests the application handler with an injected session service", async () => {
    const openRuntimeApplication = vi.fn(async ({ onReady }) => {
      onReady({ url: "http://localhost:5175" });
      return {
        started: { output: "started" },
        verified: { output: "verified" },
        preparations: [],
        application: { stoppedBy: "SIGINT" },
        lifecycle: {
          mode: "stop-on-application-exit",
          runtimeState: "stopped",
          dataState: "preserved",
          stop: { output: "stopped" },
        },
      };
    });
    const [handler] = createApplicationCommandHandlers({
      openRuntimeApplication,
    });
    const commandContext = {
      ...context("open", ["--plain"]),
      guided: true,
    };
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const result = await handler.handle(commandContext);
      expect(openRuntimeApplication).toHaveBeenCalledOnce();
      expect(commandContext.state.lastGuidedDetails).toBe(
        "started\nverified\nstopped",
      );
      expect(result.kind).toBe("rendered");
      expect(result.render("normal")).toContain("SANDBOX APP CLOSED");
    } finally {
      log.mockRestore();
    }
  });
});
