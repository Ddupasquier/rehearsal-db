/** Keep direct target-manager entry points inside the same local-engine and quota boundary. */

import type { NormalizedRehearsalConfig } from "../project/configuration.mjs";
import { readFile } from "node:fs/promises";
import { createCleanProcessEnvironment } from "../shared/process_environment.mjs";
import {
  bindRuntimeDockerEnvironment,
  runtimeDockerEnvironment,
} from "./local_docker_context.mjs";
import {
  assertResourcePolicyAllowsStartup,
  evaluateResourcePolicy,
} from "./resource_policy.mjs";
import { assertRequiredSupabaseServicesEnabled } from "../targets/supabase_service_requirements.mjs";
import { assertRuntimeConfigurationBinding } from "./configuration_binding.mjs";

export const createRuntimeManagerEnvironment = () =>
  createCleanProcessEnvironment({ overrides: runtimeDockerEnvironment() });

export const guardRuntimeManagerAction = async (
  {
    projectRoot,
    configPath,
    config,
    paths,
  }: {
    readonly projectRoot: string;
    readonly configPath: string;
    readonly config: NormalizedRehearsalConfig;
    readonly paths: { readonly rehearsalConfig: string | null };
  },
  action: string,
): Promise<void> => {
  assertRuntimeConfigurationBinding({
    config,
    expected: process.env.REHEARSAL_CONFIGURATION_SHA256,
  });
  if (["status", "candidates"].includes(action)) return;
  if (
    ["run", "reset", "start", "migrate", "verify"].includes(action) &&
    config.supabase &&
    config.application.requiredServices.length &&
    paths.rehearsalConfig
  ) {
    assertRequiredSupabaseServicesEnabled({
      template: await readFile(paths.rehearsalConfig, "utf8"),
      requiredServices: config.application.requiredServices,
    });
  }
  bindRuntimeDockerEnvironment({
    cwd: projectRoot,
    ...(process.env.REHEARSAL_DOCKER_CONTEXT
      ? { context: process.env.REHEARSAL_DOCKER_CONTEXT }
      : {}),
    ...(process.env.REHEARSAL_DOCKER_IDENTITY
      ? { expectedIdentity: process.env.REHEARSAL_DOCKER_IDENTITY }
      : {}),
  });
  if (
    config.resources.maximumBytes !== null &&
    ["run", "reset", "start", "migrate"].includes(action)
  ) {
    const { inspectRehearsalResources } =
      await import("./resource_inventory.mjs");
    const inventory = await inspectRehearsalResources({
      projectRoot,
      configPath,
    });
    assertResourcePolicyAllowsStartup(
      evaluateResourcePolicy({ inventory, policy: config.resources }),
    );
  }
};
