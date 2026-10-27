/** Command requirements and scoped observations; no executable configuration or tool probes. */
import {
  inspectHostPlatform,
  type HostPlatformOptions,
} from "../shared/host_platform.mjs";
import { inspectRehearsalNodeRuntime } from "../shared/node_runtime.mjs";
import { inspectReceiptProvenance } from "./receipt_provenance.mjs";

export const COMMAND_CAPABILITIES_SCHEMA_VERSION = 1;
export type CommandBackend = "offline" | "native" | "container";
export type CapabilitySupportState =
  "supported" | "unsupported" | "unknown" | "not-applicable";
export type CapabilityAvailability = "available" | "unavailable" | "unknown";
export type CommandAssurance = "inspection" | "partial" | "full";
export interface CommandCapability {
  readonly commands: readonly string[];
  readonly backend: CommandBackend;
  readonly supportState: CapabilitySupportState;
  readonly availability: CapabilityAvailability;
  readonly assuranceWhenCompleted: CommandAssurance;
  readonly reason:
    | "qualified"
    | "qualification_missing"
    | "observation_missing"
    | "feature_unsupported"
    | "version_unqualified";
  readonly requirements: readonly string[];
}
export const inspectCommandCapabilities = async (
  options: {
    projectRoot?: string;
    receiptPath?: string;
    hostOptions?: HostPlatformOptions;
    nodeVersion?: string;
  } = {},
) => {
  const projectRoot = options.projectRoot ?? process.cwd();
  const host = await inspectHostPlatform({
    ...options.hostOptions,
    projectRoot,
  });
  const node = inspectRehearsalNodeRuntime(options.nodeVersion);
  const offline = (
    commands: readonly string[],
    requirements: readonly string[],
    hostRequired = true,
  ): CommandCapability => ({
    commands,
    backend: "offline",
    supportState: !node.supported
      ? "unsupported"
      : hostRequired && !host.supported
        ? "unsupported"
        : "supported",
    availability: !hostRequired
      ? commands.includes("inspect capabilities") && node.supported
        ? "available"
        : "unknown"
      : !node.supported || !host.supported
        ? "unavailable"
        : "unknown",
    assuranceWhenCompleted: "inspection",
    reason: !node.supported
      ? "version_unqualified"
      : hostRequired && !host.supported
        ? "qualification_missing"
        : hostRequired
          ? "observation_missing"
          : "qualified",
    requirements,
  });
  const runtime = (
    commands: readonly string[],
    assuranceWhenCompleted: CommandAssurance,
    requirements: readonly string[],
  ): CommandCapability => ({
    commands,
    backend: "container",
    supportState:
      node.supported && host.supported ? "supported" : "unsupported",
    availability: node.supported && host.supported ? "unknown" : "unavailable",
    assuranceWhenCompleted,
    reason: !node.supported
      ? "version_unqualified"
      : !host.supported
        ? "qualification_missing"
        : "observation_missing",
    requirements,
  });
  const operations: CommandCapability[] = [
    offline(
      ["help", "version", "inspect capabilities"],
      ["supported-node"],
      false,
    ),
    offline(
      ["discover"],
      ["supported-node", "readable-project-metadata"],
      false,
    ),
    offline(
      ["init"],
      [
        "supported-node",
        "qualified-project-filesystem",
        "reviewed-project-configuration-if-present",
      ],
    ),
    offline(
      ["setup"],
      [
        "supported-node",
        "qualified-project-filesystem",
        "reviewed-project-configuration-if-present",
        "available-ports",
        "optional-container-engine-observations",
      ],
    ),
    offline(
      ["configuration", "configuration review"],
      [
        "supported-node",
        "qualified-project-filesystem",
        "reviewed-project-configuration",
      ],
    ),
    offline(
      [
        "explain",
        "run --dry-run",
        "candidates",
        "inspect baseline",
        "inspect migrations",
        "inspect plan",
        "inspect insights",
        "inspect impact",
        "inspect sizing",
      ],
      [
        "supported-node",
        "qualified-project-filesystem",
        "reviewed-project-configuration",
        "verified-baseline-and-migration-inputs",
        "reviewed-native-toolchain-if-configured",
      ],
    ),
    runtime(["setup --write"], "inspection", [
      "supported-node",
      "qualified-project-filesystem",
      "reviewed-project-configuration-if-present",
      "available-ports",
      "scaffolding-write-before-full-doctor",
      "selected-local-container-runtime-for-readiness",
      "supabase-cli-only-for-supabase",
    ]),
    runtime(["measure impact"], "partial", [
      "supported-node",
      "qualified-host-and-filesystem",
      "reviewed-project-configuration",
      "verified-baseline-and-migration-inputs",
      "explicit-target",
      "exact-candidate-confirmation",
      "running-owned-local-container-runtime",
    ]),
    runtime(["run"], "full", [
      "supported-node",
      "qualified-host-and-filesystem",
      "reviewed-project-configuration",
      "verified-baseline-and-migration-inputs",
      "selected-owned-local-container-runtime",
      "supabase-cli-only-for-supabase",
      "reviewed-application-proof",
    ]),
    runtime(
      ["start", "reset", "migrate", "verify", "status", "stop", "discard"],
      "partial",
      [
        "supported-node",
        "qualified-host-and-filesystem",
        "reviewed-project-configuration",
        "selected-owned-local-container-runtime",
        "operation-specific-ownership-and-confirmation",
        "supabase-cli-only-for-supabase",
      ],
    ),
    {
      commands: ["native PostgreSQL execution"],
      backend: "native",
      supportState: "unsupported",
      availability: "unknown",
      assuranceWhenCompleted: "partial",
      reason: "feature_unsupported",
      requirements: ["separately-qualified-native-runtime"],
    },
  ];
  return {
    schemaVersion: COMMAND_CAPABILITIES_SCHEMA_VERSION,
    assurance: "inspection" as const,
    host: { kind: host.kind, runtimeHostQualified: host.supported },
    node: {
      major: Number.isSafeInteger(node.major) ? node.major : null,
      supported: node.supported,
    },
    operations,
    receipt: await inspectReceiptProvenance({
      projectRoot,
      ...(options.receiptPath === undefined
        ? {}
        : { receiptPath: options.receiptPath }),
      filesystemQualified: host.supported,
    }),
    safety: {
      projectConfigurationEvaluated: false,
      childProcessesStarted: false,
      enginesProbed: false,
      databaseObserved: false,
      filesWritten: false,
    },
  };
};
