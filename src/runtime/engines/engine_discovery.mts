/** Read-only prelaunch choices. Availability is separate from vendor conformance. */
import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { inspectHostPlatform } from "../../shared/host_platform.mjs";
import type { HostPlatformInspection } from "../../shared/host_platform.mjs";
import {
  assertLocalDockerContext,
  scopedDockerEnvironment,
  isLocalDockerEndpoint,
} from "./local_docker_context.mjs";
import type { DockerContextRunner } from "./local_docker_context.mjs";

type Runner = DockerContextRunner;
type Provider =
  | "docker"
  | "docker-desktop"
  | "colima"
  | "orbstack"
  | "podman"
  | "rancher-desktop";
const providers: readonly {
  id: Provider;
  label: string;
  tool: string;
  platforms: readonly string[];
}[] = [
  {
    id: "docker",
    label: "Docker Engine",
    tool: "docker",
    platforms: ["linux", "wsl2"],
  },
  {
    id: "docker-desktop",
    label: "Docker Desktop",
    tool: "docker",
    platforms: ["macos", "linux", "wsl2", "windows"],
  },
  {
    id: "colima",
    label: "Colima",
    tool: "colima",
    platforms: ["macos", "linux"],
  },
  { id: "orbstack", label: "OrbStack", tool: "orb", platforms: ["macos"] },
  {
    id: "podman",
    label: "Podman",
    tool: "podman",
    platforms: ["macos", "linux", "wsl2", "windows"],
  },
  {
    id: "rancher-desktop",
    label: "Rancher Desktop",
    tool: "rdctl",
    platforms: ["macos", "linux", "wsl2", "windows"],
  },
];
const providerFor = (context: string): Provider =>
  context === "desktop-linux"
    ? "docker-desktop"
    : context === "orbstack"
      ? "orbstack"
      : /^colima(?:-|$)/u.test(context)
        ? "colima"
        : /^podman(?:-|$)/u.test(context)
          ? "podman"
          : context === "rancher-desktop"
            ? "rancher-desktop"
            : "docker";
const run: Runner = (command, args, cwd, env) =>
  spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 2000,
    maxBuffer: 65536,
    stdio: ["ignore", "pipe", "pipe"],
  });
const toolPresent = (
  command: string,
  environment: NodeJS.ProcessEnv,
): boolean => {
  const path = environment.PATH ?? "";
  if (path.length > 8192) return false;
  return path
    .split(delimiter)
    .slice(0, 32)
    .some((directory) => {
      if (!directory || !/^(?:\/|[A-Za-z]:[\\/])/u.test(directory))
        return false;
      try {
        accessSync(
          join(
            directory,
            command + (process.platform === "win32" ? ".exe" : ""),
          ),
          constants.X_OK,
        );
        return true;
      } catch {
        return false;
      }
    });
};

export interface ContainerEngineDiscovery {
  readonly schemaVersion: 1;
  readonly host: {
    readonly kind: HostPlatformInspection["kind"];
    readonly supported: boolean;
  };
  readonly state:
    "ready" | "selection-required" | "unavailable" | "unsupported-host";
  readonly selected: {
    readonly context: string;
    readonly provider: Provider;
    readonly endpointIdentity: string;
    readonly daemonId: string;
    readonly serverVersion: string;
  } | null;
  readonly options: readonly {
    readonly provider: Provider;
    readonly label: string;
    readonly platforms: readonly string[];
    readonly installed: "detected" | "not-detected" | "unknown";
    readonly contexts: readonly string[];
    readonly selected: boolean;
    readonly qualification: "docker-api-not-vendor-conformance";
  }[];
  readonly notes: readonly string[];
  readonly safety: {
    readonly enginesStarted: false;
    readonly globalContextChanged: false;
    readonly remoteDaemonsContacted: false;
  };
}

export const inspectContainerEngineOptions = async ({
  projectRoot = process.cwd(),
  inheritedEnvironment = process.env,
  runner = run,
  hostInspection,
  hasTool = (command: string) => toolPresent(command, inheritedEnvironment),
}: {
  projectRoot?: string;
  inheritedEnvironment?: NodeJS.ProcessEnv;
  runner?: Runner;
  hostInspection?: HostPlatformInspection;
  hasTool?: (command: string) => boolean;
} = {}): Promise<ContainerEngineDiscovery> => {
  const host = hostInspection ?? (await inspectHostPlatform({ projectRoot }));
  const contexts: string[] = [];
  const notes: string[] = [];
  let selected: ContainerEngineDiscovery["selected"] = null;
  let state: ContainerEngineDiscovery["state"] = host.supported
    ? "unavailable"
    : "unsupported-host";
  const dockerPresent = hasTool("docker");
  if (dockerPresent && host.supported) {
    try {
      const environment = scopedDockerEnvironment({ inheritedEnvironment });
      // Metadata only; alternate daemons are never probed or started.
      const listing = runner(
        "docker",
        [
          "context",
          "ls",
          "--format",
          '{"Name":{{json .Name}},"Endpoint":{{json .DockerEndpoint}}}',
        ],
        projectRoot,
        environment,
      );
      if (
        listing.status === 0 &&
        Buffer.byteLength(listing.stdout ?? "") <= 65536
      ) {
        const lines = listing.stdout.trim().split("\n").filter(Boolean);
        if (lines.length > 32) throw new Error();
        for (const line of lines) {
          const entry = JSON.parse(line) as {
            Name?: unknown;
            Endpoint?: unknown;
          } | null;
          const name = entry?.Name;
          if (
            typeof name !== "string" ||
            !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u.test(name) ||
            contexts.includes(name)
          )
            throw new Error();
          if (isLocalDockerEndpoint(entry?.Endpoint)) contexts.push(name);
        }
      }
      const local = assertLocalDockerContext({
        cwd: projectRoot,
        inheritedEnvironment,
        runner,
      });
      if (host.supported) {
        const result = runner(
          "docker",
          [
            "--host",
            local.endpoint,
            "info",
            "--format",
            '{"ID":{{json .ID}},"ServerVersion":{{json .ServerVersion}}}',
          ],
          projectRoot,
          environment,
        );
        if (
          result.status !== 0 ||
          Buffer.byteLength(result.stdout ?? "") > 65536
        )
          throw new Error();
        const info: unknown = JSON.parse(result.stdout);
        if (!info || typeof info !== "object" || Array.isArray(info))
          throw new Error();
        const { ID, ServerVersion } = info as Record<string, unknown>;
        if (
          typeof ID !== "string" ||
          !/^[a-zA-Z0-9][a-zA-Z0-9:_.-]{0,255}$/u.test(ID) ||
          typeof ServerVersion !== "string" ||
          !/^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,127}$/u.test(ServerVersion)
        )
          throw new Error();
        selected = {
          context: local.context,
          provider: providerFor(local.context),
          endpointIdentity: local.identity,
          daemonId: ID,
          serverVersion: ServerVersion,
        };
        state = "ready";
      }
    } catch {
      if (host.supported) state = "selection-required";
      notes.push(
        "The selected local engine could not be verified. Choose or start your intended local Docker context explicitly; Rehearsal will not switch engines or migrate existing data.",
      );
    }
  } else if (!dockerPresent)
    notes.push(
      "Docker CLI was not detected. Install a compatible local engine only when you choose a container-backed operation.",
    );
  if (!host.supported) notes.push(host.remediation);
  notes.push(
    "Context names and tool presence are discovery hints, not verified vendor compatibility or measured memory savings. Capacity and retained-runtime ownership checks still apply at launch.",
  );
  return {
    schemaVersion: 1,
    host: { kind: host.kind, supported: host.supported },
    state,
    selected,
    options: providers
      .filter((provider) => provider.platforms.includes(host.kind))
      .map((provider) => ({
        provider: provider.id,
        label: provider.label,
        platforms: provider.platforms,
        installed:
          provider.tool === "docker"
            ? "unknown"
            : hasTool(provider.tool)
              ? "detected"
              : "not-detected",
        contexts: contexts.filter(
          (context) => providerFor(context) === provider.id,
        ),
        selected: selected?.provider === provider.id,
        qualification: "docker-api-not-vendor-conformance",
      })),
    notes,
    safety: {
      enginesStarted: false,
      globalContextChanged: false,
      remoteDaemonsContacted: false,
    },
  };
};
