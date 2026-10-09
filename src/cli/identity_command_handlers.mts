/** Provider-neutral copied-account planning, application, and guided connection. */

import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import * as prompts from "@clack/prompts";
import { holdApplicationSession } from "../application/session.mjs";
import { runApplicationSessionTask } from "../application/interactive_task.mjs";
import { applyIdentityClaim } from "../identity/claim.mjs";
import { waitForIdentityConnection } from "../identity/connect.mjs";
import { createSupabaseStorageTransfer } from "../identity/storage.mjs";
import {
  exactCommands,
  renderedCommand,
  textCommand,
} from "./command_contract.mjs";
import type { CommandDefinition } from "./command_contract.mjs";
import type { createProjectCommands } from "./project_commands.mjs";
import { renderIdentityConnection } from "./identity_renderer.mjs";
import { renderIdentityPlan } from "./renderers.mjs";
import type { createRuntimeCommands } from "./runtime_commands.mjs";
import {
  isHumanTerminal,
  promptForConfirmation,
  promptForSelection,
  useStyledPrompts,
} from "./terminal.mjs";

type ProjectCommands = ReturnType<typeof createProjectCommands>;
type RuntimeCommands = ReturnType<typeof createRuntimeCommands>;
type LoadedIdentity = Awaited<
  ReturnType<ProjectCommands["loadIdentityClaimPlan"]>
>;

const loadIdentityRuntime = async (loaded: LoadedIdentity["loaded"]) => {
  const environment = parseEnv(
    await readFile(loaded.paths.applicationEnvironment, "utf8"),
  );
  if (!environment.DATABASE_URL) {
    throw new Error("The local runtime environment has no DATABASE_URL.");
  }
  return environment;
};

const storageTransferFor = ({
  plan,
  environment,
}: {
  plan: LoadedIdentity["plan"];
  environment: Readonly<Record<string, string | undefined>>;
}) => {
  const needsStorageTransfer = plan.identity.assets.some(
    (asset) => asset.rewritePath,
  );
  if (!needsStorageTransfer) return undefined;
  if (!environment.SUPABASE_URL || !environment.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error(
      "Identity asset transfer requires local Supabase URL and service-role credentials.",
    );
  }
  return createSupabaseStorageTransfer({
    url: environment.SUPABASE_URL,
    serviceRoleKey: environment.SUPABASE_SERVICE_ROLE_KEY,
  });
};

export const createIdentityCommandHandlers = ({
  loadIdentityClaimPlan,
  loadIdentityPolicy,
  startRuntimeApplication,
}: {
  loadIdentityClaimPlan: ProjectCommands["loadIdentityClaimPlan"];
  loadIdentityPolicy: ProjectCommands["loadIdentityPolicy"];
  startRuntimeApplication: RuntimeCommands["startRuntimeApplication"];
}): readonly CommandDefinition[] => [
  exactCommands(
    "identity",
    ["identity plan", "identity claim", "identity connect"],
    async ({ command, flags, planOptions, guided, state }) => {
      if (command === "identity connect") {
        if (!isHumanTerminal(flags)) {
          throw new Error(
            "identity connect requires an interactive terminal. Scripts should keep using identity plan and identity claim.",
          );
        }
        if (!flags.identityName) {
          const { policy } = await loadIdentityPolicy({
            flags,
            planOptions,
            session: state,
          });
          if (policy.identities.length === 1) {
            flags.identityName = policy.identities[0]!.name;
          } else {
            const selected = await promptForSelection({
              message: "Which copied account would you like to connect?",
              flags,
              options: policy.identities.map((identity) => ({
                label: identity.name,
                value: identity.name,
              })),
            });
            if (!selected) {
              return textCommand(
                "COPIED ACCOUNT CONNECTION CANCELLED\nNothing was changed.",
              );
            }
            flags.identityName = selected;
          }
        }
        const initial = await loadIdentityClaimPlan({
          flags,
          planOptions,
          session: state,
        });
        const initialEnvironment = await loadIdentityRuntime(initial.loaded);
        let active:
          | Awaited<ReturnType<RuntimeCommands["startRuntimeApplication"]>>
          | undefined;
        let reopened:
          | Awaited<ReturnType<RuntimeCommands["startRuntimeApplication"]>>
          | undefined;
        try {
          active = await startRuntimeApplication({
            flags,
            planOptions,
            session: state,
          });
          const observed = await runApplicationSessionTask({
            session: active.session,
            onReady: (ready) => {
              const lines = [
                `Application: ${ready.url}`,
                "Sign in normally with the provider allowed by your reviewed identity policy.",
                "Rehearsal will continue when exactly one approved, verified local identity appears.",
                "It never reads your provider password, passkey, MFA secret, browser cookies, or session tokens.",
                "Press Ctrl+C to cancel or Ctrl+Z to exit Rehearsal.",
              ];
              if (useStyledPrompts(flags)) {
                prompts.note(lines.join("\n"), "SIGN IN TO THE SANDBOX");
              } else {
                console.log(
                  ["", "SIGN IN TO THE SANDBOX", ...lines, ""].join("\n"),
                );
              }
            },
            task: (signal) =>
              waitForIdentityConnection({
                plan: initial.plan,
                connectionString: initialEnvironment.DATABASE_URL!,
                signal,
              }),
          });
          if (!observed.completed) {
            if (guided && observed.signal === "SIGTSTP") {
              flags.exitGuidedSession = true;
            }
            return textCommand(
              [
                "COPIED ACCOUNT CONNECTION CANCELLED",
                `Application stopped after ${observed.signal}.`,
                "Nothing was changed. The database runtime was preserved.",
              ].join("\n"),
            );
          }
          const preview = observed.value;
          if (preview.associated) {
            const closed = await holdApplicationSession({
              session: active.session,
              onReady: () => {
                const message = renderIdentityConnection({
                  mode: "already-connected",
                  preview,
                });
                if (useStyledPrompts(flags)) {
                  prompts.note(message, "SANDBOX READY");
                } else {
                  console.log(`\n${message}\n`);
                }
              },
            });
            if (guided && closed.signal === "SIGTSTP") {
              flags.exitGuidedSession = true;
            }
            return renderedCommand({
              data: {
                mode: "already-connected" as const,
                preview,
                application: { stoppedBy: closed.signal },
              },
              render: ({ mode, preview: renderedPreview }) =>
                renderIdentityConnection({ mode, preview: renderedPreview }),
            });
          }

          await active.session.stop();
          console.log(
            `\n${renderIdentityConnection({ mode: "preview", preview })}\n`,
          );
          const accepted = await promptForConfirmation(
            "Connect my copied account using exactly this plan?",
            flags,
          );
          if (!accepted) {
            return renderedCommand({
              data: { mode: "cancelled" as const, preview },
              render: ({ mode, preview: renderedPreview }) =>
                renderIdentityConnection({ mode, preview: renderedPreview }),
            });
          }

          const refreshed = await loadIdentityClaimPlan({
            flags,
            planOptions,
            session: state,
          });
          if (refreshed.plan.digest !== preview.planDigest) {
            throw new Error(
              "The reviewed identity plan changed after sign-in. Nothing was changed; start the connection again.",
            );
          }
          const refreshedEnvironment = await loadIdentityRuntime(
            refreshed.loaded,
          );
          const storageTransfer = storageTransferFor({
            plan: refreshed.plan,
            environment: refreshedEnvironment,
          });
          const result = await applyIdentityClaim({
            plan: refreshed.plan,
            confirmation: preview.planDigest,
            connectionString: refreshedEnvironment.DATABASE_URL!,
            ...(storageTransfer === undefined ? {} : { storageTransfer }),
          });

          reopened = await startRuntimeApplication({
            flags,
            planOptions,
            session: state,
          });
          const closed = await holdApplicationSession({
            session: reopened.session,
            onReady: (ready) => {
              const lines = [
                renderIdentityConnection({
                  mode: "connected",
                  preview,
                  result,
                }),
                "",
                `Application: ${ready.url}`,
                "The app is running again. Sign out and sign in once for fresh claims.",
                "Press Ctrl+C to close the app or Ctrl+Z to exit Rehearsal.",
              ];
              if (useStyledPrompts(flags)) {
                prompts.note(lines.join("\n"), "ACCOUNT CONNECTED");
              } else {
                console.log(["", ...lines, ""].join("\n"));
              }
            },
          });
          if (guided && closed.signal === "SIGTSTP") {
            flags.exitGuidedSession = true;
          }
          return renderedCommand({
            data: {
              mode: "connected" as const,
              preview,
              result,
              application: { stoppedBy: closed.signal },
            },
            render: ({ mode, preview: renderedPreview, result: claimResult }) =>
              renderIdentityConnection({
                mode,
                preview: renderedPreview,
                result: claimResult,
              }),
          });
        } finally {
          await active?.session.stop();
          await reopened?.session.stop();
        }
      }

      const { loaded, plan } = await loadIdentityClaimPlan({
        flags,
        planOptions,
        session: state,
      });
      if (command === "identity plan" || !flags.identityConfirmation) {
        const data = { mode: "preview" as const, plan };
        return renderedCommand({ data, render: renderIdentityPlan });
      }
      const runtimeEnvironment = await loadIdentityRuntime(loaded);
      const storageTransfer = storageTransferFor({
        plan,
        environment: runtimeEnvironment,
      });
      const result = await applyIdentityClaim({
        plan,
        confirmation: flags.identityConfirmation,
        connectionString: runtimeEnvironment.DATABASE_URL!,
        ...(storageTransfer === undefined ? {} : { storageTransfer }),
      });
      const data = { mode: "written" as const, plan, result };
      return renderedCommand({ data, render: renderIdentityPlan });
    },
  ),
];
