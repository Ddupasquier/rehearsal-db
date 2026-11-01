/** Exact completed-container claims; never infer completion from age or stopped state. */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import {
  planContainerRetirement,
  retireContainers,
  type ContainerRetirementClaim,
} from "../runtime/resources/container_retirement.mjs";
import { assertLocalDockerContext } from "../runtime/engines/local_docker_context.mjs";
import { createCleanProcessEnvironment } from "../shared/process_environment.mjs";
import {
  exactCommands,
  renderedCommand,
  type CommandDefinition,
} from "./command_contract.mjs";

export const readContainerRetirementClaims = async (
  path: string,
): Promise<readonly ContainerRetirementClaim[]> => {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size < 2 || before.size > 65536)
      throw new Error(
        "Container cleanup requires a regular claims file of at most 64 KiB.",
      );
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(
        bytes,
        length,
        bytes.length - length,
        null,
      );
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const after = await file.stat();
    if (
      length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error("Container cleanup claims changed during inspection.");
    let value: unknown;
    try {
      value = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.subarray(0, length),
        ),
      );
    } catch {
      throw new Error("Container cleanup claims must be valid UTF-8 JSON.");
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(
        "Container cleanup requires explicit versioned completed-disposable claims.",
      );
    const request = value as Record<string, unknown>;
    if (
      request.schemaVersion !== 1 ||
      Object.keys(request).some(
        (key) => !["schemaVersion", "claims"].includes(key),
      ) ||
      !Array.isArray(request.claims)
    )
      throw new Error(
        "Container cleanup requires schemaVersion 1 and explicit claims.",
      );
    // The retirement API validates all IDs, labels, bounds and completion declarations
    // before retirement inspection/removal. No label implies completion by itself.
    return request.claims as ContainerRetirementClaim[];
  } finally {
    await file.close();
  }
};

export const createContainerCommandHandlers =
  (): readonly CommandDefinition[] => [
    exactCommands(
      "cleanup-containers",
      ["cleanup containers"],
      async ({ flags, planOptions }) => {
        if (!flags.proposalPath)
          throw new Error(
            "cleanup containers requires --proposal=<completed-container-claims.json>; no resources were changed.",
          );
        const claims = await readContainerRetirementClaims(flags.proposalPath);
        const cwd = planOptions.projectRoot ?? process.cwd();
        const local = assertLocalDockerContext({ cwd });
        const identity = spawnSync(
          "docker",
          ["--host", local.endpoint, "info", "--format", "{{.ID}}"],
          {
            cwd,
            env: createCleanProcessEnvironment(),
            encoding: "utf8",
            timeout: 5000,
            maxBuffer: 65536,
            stdio: ["ignore", "pipe", "ignore"],
          },
        );
        if (identity.status !== 0 || identity.error)
          throw new Error(
            "Container cleanup could not verify the local engine; no resources were changed.",
          );
        const plan = planContainerRetirement({
          binding: {
            context: local.context,
            endpoint: local.endpoint,
            daemonId: identity.stdout.trim(),
          },
          claims,
        });
        if (!flags.write)
          return renderedCommand({
            data: { mode: "preview", ...plan },
            render: (value) =>
              `CONTAINER RETIREMENT — PREVIEW\n${value.claims.length} explicitly completed stopped container(s). All volumes are preserved; container writable layers are removed.\nReview --confirm-cleanup=${value.consentDigest} and rerun with --write.`,
          });
        if (!flags.cleanupConfirmation)
          throw new Error(
            "Container retirement requires the exact --confirm-cleanup digest from a fresh preview.",
          );
        const result = retireContainers({
          plan,
          consent: { kind: "manual", digest: flags.cleanupConfirmation },
        });
        return renderedCommand({
          data: { mode: "applied", ...result },
          status: result.status === "completed" ? "success" : "error",
          exitCode: result.status === "completed" ? 0 : 1,
          render: (value) =>
            `Container retirement: ${value.status}. Inspect each outcome; volume preservation is reported only when verified.`,
        });
      },
    ),
  ];
