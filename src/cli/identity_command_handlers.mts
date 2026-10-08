/** Provider-neutral copied-account planning and application handlers. */

import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { applyIdentityClaim } from "../identity/claim.mjs";
import { createSupabaseStorageTransfer } from "../identity/storage.mjs";
import { exactCommands, renderedCommand } from "./command_contract.mjs";
import type { CommandDefinition } from "./command_contract.mjs";
import type { createProjectCommands } from "./project_commands.mjs";
import { renderIdentityPlan } from "./renderers.mjs";

type ProjectCommands = ReturnType<typeof createProjectCommands>;

export const createIdentityCommandHandlers = ({
  loadIdentityClaimPlan,
}: {
  loadIdentityClaimPlan: ProjectCommands["loadIdentityClaimPlan"];
}): readonly CommandDefinition[] => [
  exactCommands(
    "identity",
    ["identity plan", "identity claim"],
    async ({ command, flags, planOptions }) => {
      const { loaded, plan } = await loadIdentityClaimPlan({
        flags,
        planOptions,
      });
      if (command === "identity plan" || !flags.identityConfirmation) {
        const data = { mode: "preview" as const, plan };
        return renderedCommand({ data, render: renderIdentityPlan });
      }
      const runtimeEnvironment = parseEnv(
        await readFile(loaded.paths.applicationEnvironment, "utf8"),
      );
      if (!runtimeEnvironment.DATABASE_URL) {
        throw new Error("The local runtime environment has no DATABASE_URL.");
      }
      const needsStorageTransfer = plan.identity.assets.some(
        (asset) => asset.rewritePath,
      );
      if (
        needsStorageTransfer &&
        (!runtimeEnvironment.SUPABASE_URL ||
          !runtimeEnvironment.SUPABASE_SERVICE_ROLE_KEY)
      ) {
        throw new Error(
          "Identity asset transfer requires local Supabase URL and service-role credentials.",
        );
      }
      const storageTransfer = needsStorageTransfer
        ? createSupabaseStorageTransfer({
            url: runtimeEnvironment.SUPABASE_URL!,
            serviceRoleKey: runtimeEnvironment.SUPABASE_SERVICE_ROLE_KEY!,
          })
        : undefined;
      const result = await applyIdentityClaim({
        plan,
        confirmation: flags.identityConfirmation,
        connectionString: runtimeEnvironment.DATABASE_URL,
        ...(storageTransfer === undefined ? {} : { storageTransfer }),
      });
      const data = { mode: "written" as const, plan, result };
      return renderedCommand({ data, render: renderIdentityPlan });
    },
  ),
];
