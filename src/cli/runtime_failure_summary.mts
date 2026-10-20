/** Keep useful manager failures rather than debug advice and trailing Node stacks. */
import { redactDiagnosticValue } from "../shared/diagnostics.mjs";
import {
  readManagerMigrationFailure,
  renderMigrationFailureDiagnostic,
} from "../runtime/migration_failure.mjs";
import { portStartupGuidance } from "../targets/port_start_failure.mjs";

export const runtimePortFailureGuidance = (
  output: string,
): readonly string[] => {
  const provider = output.match(
    /^(?:Error:\s*)?(PostgreSQL|Supabase) startup failed \((?:exit -?\d+|process failure)\)\.$/mu,
  )?.[1];
  const evidence = output
    .match(/^Reported startup evidence: ([a-z_, ]+)\.$/mu)?.[1]
    ?.split(/,\s*/u);
  const port = evidence?.find(
    (value) => value === "port_in_use" || value === "port_unavailable",
  );
  return provider && (port === "port_in_use" || port === "port_unavailable")
    ? portStartupGuidance(
        port,
        provider === "PostgreSQL" ? "postgresql" : "supabase",
      ).split("\n")
    : [];
};

export const summarizeRuntimeManagerFailure = (output: string): string => {
  let nodeSourceContext = false;
  const lines = output
    .slice(-128 * 1024)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      // Node echoes the failing source line between a location and Error.
      // It is code, not a safe diagnostic, and may contain private literals.
      if (/^file:\/\/.*:\d+(?::\d+)?$/u.test(line)) {
        nodeSourceContext = true;
        return false;
      }
      if (nodeSourceContext) {
        if (/^[A-Za-z]*Error:/u.test(line)) nodeSourceContext = false;
        else return false;
      }
      return (
        Boolean(line) &&
        !/^(?:at\s|Node\.js v|file:\/\/|\^+$|Try rerunning .*--debug)/iu.test(
          line,
        )
      );
    })
    .map((line) =>
      String(redactDiagnosticValue(line))
        .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"']+/giu, "[REDACTED_URL]")
        .replace(/\b[A-Z][A-Z0-9_]*\s*=\s*[^\s]+/gu, "[REDACTED_ENV]")
        .replace(
          /(?:\/[A-Za-z0-9_.-]+){2,}(?::\d+(?::\d+)?)?/gu,
          "[LOCAL_PATH]",
        ),
    );
  const startup = lines.findIndex((line) =>
    /(?:PostgreSQL|Supabase) startup failed \(/u.test(line),
  );
  const failure = lines.reduce(
    (last, line, index) => (/^[A-Za-z]*Error:/u.test(line) ? index : last),
    -1,
  );
  const migration = lines.findIndex((line) =>
    /^Error: The (?:confirmed candidate|baseline) (?:PostgreSQL|Supabase) migration failed \(exit (?:-?\d+|unknown); stderr \d+ bytes\)\. SQL and provider output are withheld\.$/u.test(
      line,
    ),
  );
  const rollbackFailed =
    /The runtime operation failed and its owned runtime could not be removed automatically\./u.test(
      output,
    );
  const migrationDiagnostic =
    migration >= 0 ? readManagerMigrationFailure(lines.join("\n")) : undefined;
  const selected =
    startup >= 0
      ? lines
          .slice(startup, startup + 12)
          .filter((line) =>
            /^(?:Error:\s*)?(?:PostgreSQL|Supabase) startup failed \(|^Reported startup evidence:|^Reported service states:|^Provider logs, (?:command arguments, )?paths, environment values and connection URLs are omitted\./u.test(
              line,
            ),
          )
      : migration >= 0
        ? [
            lines[migration]!,
            ...(migrationDiagnostic
              ? [renderMigrationFailureDiagnostic(migrationDiagnostic)]
              : []),
          ]
        : rollbackFailed
          ? [
              "Error: The operation failed; the original cause could not be safely summarized.",
            ]
          : failure >= 0
            ? lines.slice(failure, failure + 8)
            : lines.slice(-8);
  if (startup >= 0)
    selected.push(...runtimePortFailureGuidance(selected.join("\n")));
  if (rollbackFailed)
    selected.push(
      "Owned rollback cleanup could not be confirmed. Resources may remain; inspect activity and status before retrying. No cleanup success is claimed.",
    );
  if (
    startup >= 0 &&
    /owned cleanup could not be proved|owned resources were retained|Resources and data were retained|retained resources need review/iu.test(
      output,
    )
  )
    selected.push(
      "Owned startup cleanup could not be proved; resources and data were retained. Inspect activity and status before retrying.",
    );
  if (selected.join("\n").length > 2_000 && migrationDiagnostic?.source) {
    // Human summary stays bounded and retains cleanup warnings; structured output
    // independently reads the complete, bounded manager frame.
    const { source: _source, ...diagnostic } = migrationDiagnostic;
    selected[1] = renderMigrationFailureDiagnostic(diagnostic);
  }
  return selected.join("\n").slice(0, 2_000);
};
