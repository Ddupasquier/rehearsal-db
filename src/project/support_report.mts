/**
 * Build a copy-ready, data-free support report. The report intentionally omits
 * project names, paths, command output, environment-variable names, row data,
 * migration contents, and baseline identifiers.
 */

import { spawnSync } from "node:child_process";
import { arch, platform, release } from "node:os";
import {
  REHEARSAL_VERSION,
  redactDiagnosticValue,
} from "../shared/diagnostics.mjs";
import { runRehearsalDoctor } from "../runtime/plan.mjs";
import type { RehearsalConfigPathOptions } from "./configuration.mjs";

interface VersionCommandResult {
  readonly error?: NodeJS.ErrnoException;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

type VersionCommandRunner = (
  command: string,
  args: readonly string[],
) => VersionCommandResult;

interface DoctorCheck {
  readonly id: string;
  readonly label: string;
  readonly status: string;
  readonly remediation?: string;
}

interface DoctorReport {
  readonly state: string;
  readonly checks: readonly DoctorCheck[];
  readonly ambientHostedVariables?: Readonly<{
    presentButQuarantined: readonly string[];
  }>;
}

interface SupportSystem {
  readonly platform: string;
  readonly release: string;
  readonly architecture: string;
  readonly node: string;
}

interface SupportDependencies {
  readonly runDoctor?: (
    options: Record<string, unknown>,
  ) => Promise<DoctorReport>;
  readonly runCommand?: VersionCommandRunner;
  readonly system?: SupportSystem;
}

export const REHEARSAL_SUPPORT_URL =
  "https://github.com/Ddupasquier/rehearsal-db/issues/new?template=bug.yml";

const safeEnvironment = () =>
  Object.fromEntries(
    ["HOME", "LANG", "LC_ALL", "PATH", "SHELL", "TMPDIR"].flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]],
    ),
  );

const runVersionCommand: VersionCommandRunner = (command, args) =>
  spawnSync(command, args, {
    encoding: "utf8",
    env: safeEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5_000,
  });

const inspectTool = ({
  command,
  args,
  runCommand,
}: {
  command: string;
  args: readonly string[];
  runCommand: VersionCommandRunner;
}) => {
  const result = runCommand(command, args);
  if (result.error?.code === "ENOENT") return { status: "not_installed" };
  if (result.status !== 0) return { status: "unavailable" };
  const version = String(result.stdout || result.stderr)
    .trim()
    .split(/\r?\n/u)[0]!
    .slice(0, 200);
  return {
    status: "available",
    version: redactDiagnosticValue(version || "version not reported"),
  };
};

export const collectRehearsalSupportReport = async (
  options: RehearsalConfigPathOptions = {},
  {
    runDoctor = runRehearsalDoctor,
    runCommand = runVersionCommand,
    system = {
      platform: platform(),
      release: release(),
      architecture: arch(),
      node: process.versions.node,
    },
  }: SupportDependencies = {},
) => {
  const doctor = await (
    runDoctor as (options: RehearsalConfigPathOptions) => Promise<DoctorReport>
  )(options);
  return {
    rehearsalVersion: REHEARSAL_VERSION,
    system,
    tools: {
      npm: inspectTool({ command: "npm", args: ["--version"], runCommand }),
      supabase: inspectTool({
        command: "supabase",
        args: ["--version"],
        runCommand,
      }),
      dockerClient: inspectTool({
        command: "docker",
        args: ["--version"],
        runCommand,
      }),
      dockerServer: inspectTool({
        command: "docker",
        args: ["info", "--format", "{{.ServerVersion}}"],
        runCommand,
      }),
    },
    readiness: {
      state: doctor.state,
      checks: doctor.checks.map(({ id, label, status, remediation }) => ({
        id,
        label,
        status,
        ...(status === "fail" && remediation ? { remediation } : {}),
      })),
      quarantinedHostedVariableCount:
        doctor.ambientHostedVariables?.presentButQuarantined.length ?? 0,
    },
    privacy: {
      omits: [
        "row values",
        "credentials",
        "project paths",
        "migration SQL",
        "baseline identifiers",
      ],
      reviewBeforeSharing: true,
    },
    supportUrl: REHEARSAL_SUPPORT_URL,
  };
};
