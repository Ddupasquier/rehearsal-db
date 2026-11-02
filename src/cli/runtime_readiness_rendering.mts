/** Pure runtime readiness and engine-choice presentation; no engine operations. */
import type { ContainerEngineDiscovery } from "../runtime/engines/engine_discovery.mjs";

export interface ReadinessCheck {
  readonly id: string;
  readonly label: string;
  readonly status: "pass" | "fail";
  readonly detail: string;
  readonly remediation?: string;
}

export interface ReadinessReport {
  readonly containerEngines?: ContainerEngineDiscovery;
  readonly state: string;
  readonly checks: readonly ReadinessCheck[];
  readonly ambientHostedVariables?: {
    readonly presentButQuarantined: readonly string[];
  };
}

export const renderDoctor = (
  doctor: ReadinessReport,
  verbosity: "normal" | "verbose",
): string => {
  const lines = doctor.checks.map((check) => {
    const marker = check.status === "pass" ? "✓" : "✗";
    const detail =
      verbosity === "normal" && check.status === "pass"
        ? ""
        : ` — ${check.detail}`;
    return `${marker} ${check.label}${detail}`;
  });
  for (const check of doctor.checks.filter(
    (entry) => entry.status === "fail",
  )) {
    if (check.remediation) lines.push(`  Try: ${check.remediation}`);
  }
  if (doctor.ambientHostedVariables?.presentButQuarantined.length) {
    lines.push(
      `! ${doctor.ambientHostedVariables.presentButQuarantined.length} ambient hosted credential variables detected and quarantined.`,
    );
  }
  return [
    ...renderEngineOptions(doctor.containerEngines),
    ...lines,
    "",
    doctor.state,
    "",
    doctor.state === "READY"
      ? "Next: run rehearsal explain to review the migration plan."
      : "Next: fix the items above, then run rehearsal doctor again.",
  ].join("\n");
};

export const renderEngineOptions = (
  engines?: ContainerEngineDiscovery,
): string[] =>
  engines
    ? [
        `Machine: ${engines.host.kind}`,
        engines.selected
          ? `Engine: ${engines.selected.context} (selected local Docker context)`
          : "Engine: no supported local selection is ready; choose/start your intended engine.",
        ...engines.options
          .filter(
            (option) =>
              !option.selected &&
              (option.contexts.length || option.installed === "detected"),
          )
          .map(
            (option) =>
              `  Option: ${option.label}${option.contexts.length ? ` — ${option.contexts.join(", ")}` : " — tool detected"} (not probed; compatibility requires verification)`,
          ),
        "Engine selection preserves existing data; it does not migrate it or change the global Docker context.",
        "",
      ]
    : [];
