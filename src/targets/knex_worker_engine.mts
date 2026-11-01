/** Read-only selected-engine/image preflight, reusable before destructive runtime reset. */
import { spawnSync } from "node:child_process";
import {
  assertLocalDockerContext,
  scopedDockerEnvironment,
  runtimeDockerEnvironment,
  runtimeDockerContext,
} from "../runtime/engines/local_docker_context.mjs";
import {
  KNEX_WORKER_POLICY,
  KNEX_WORKER_PLATFORM_IMAGES,
} from "../runtime/migrations/knex_isolation_contract.mjs";
const refused = () =>
  new Error(
    "The reviewed local Knex worker image or engine is unavailable or changed; no image was pulled and no runtime data was changed.",
  );
export const inspectKnexWorkerEngine = ({
  cwd,
  projectId,
  runtimeWorkdir,
}: {
  cwd: string;
  projectId?: string;
  runtimeWorkdir?: string;
}) => {
  if (process.platform === "win32")
    throw new Error(
      "Isolated Knex execution requires a supported POSIX host path and Linux Docker daemon; native Windows execution is unqualified. Use the reviewed WSL route instead.",
    );
  for (const path of [cwd, ...(runtimeWorkdir ? [runtimeWorkdir] : [])])
    if (!path.startsWith("/") || /[,:\r\n\0]/u.test(path))
      throw new Error(
        "Knex worker mount paths are unsupported; no runtime data was changed.",
      );
  const runtimeBinding = runtimeDockerEnvironment(),
    inherited = { ...process.env, ...runtimeBinding },
    reviewedContext = runtimeDockerContext(),
    selection = assertLocalDockerContext({
      cwd,
      inheritedEnvironment: inherited,
      ...(reviewedContext ? { context: reviewedContext } : {}),
    }),
    env = scopedDockerEnvironment({
      inheritedEnvironment: inherited,
      endpoint: selection.endpoint,
    });
  if (
    runtimeBinding.DOCKER_HOST &&
    (selection.endpoint !== runtimeBinding.DOCKER_HOST ||
      selection.dockerConfig !== runtimeBinding.DOCKER_CONFIG)
  )
    throw refused();
  const docker = (args: readonly string[]) => {
    const r = spawnSync("docker", ["--host", selection.endpoint, ...args], {
      cwd,
      env,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (r.error || r.status !== 0) throw refused();
    return r.stdout.trim();
  };
  const daemon = docker(["info", "--format", "{{.ID}}"]);
  if (!/^[A-Za-z0-9:_-]{1,256}$/u.test(daemon)) throw refused();
  let capabilities;
  try {
    capabilities = JSON.parse(docker(["info", "--format", "{{json .}}"]));
  } catch {
    throw refused();
  }
  if (
    capabilities.ID !== daemon ||
    capabilities.OSType !== "linux" ||
    ![
      capabilities.MemoryLimit,
      capabilities.SwapLimit,
      capabilities.PidsLimit,
      capabilities.CpuCfsQuota,
    ].every((x) => x === true) ||
    !Array.isArray(capabilities.SecurityOptions) ||
    !capabilities.SecurityOptions.includes("name=seccomp,profile=builtin")
  )
    throw refused();
  if (projectId) {
    const ids = docker([
      "ps",
      "--all",
      "--no-trunc",
      "--filter",
      "label=com.rehearsal-db.worker=knex",
      "--filter",
      `label=com.rehearsal-db.project=${projectId}`,
      "--format",
      "{{.ID}}",
    ]);
    if (ids !== "")
      throw new Error(
        "A prior project Knex worker requires verified cleanup; existing runtime data and worker evidence were preserved.",
      );
  }
  let image;
  try {
    const rows = JSON.parse(
      docker(["image", "inspect", KNEX_WORKER_POLICY.image]),
    );
    if (!Array.isArray(rows) || rows.length !== 1) throw refused();
    image = rows[0];
  } catch {
    throw refused();
  }
  const arch: unknown = image.Architecture;
  if (arch !== "arm64" && arch !== "amd64") throw refused();
  if (
    !(arch === "arm64" ? ["arm64", "aarch64"] : ["amd64", "x86_64"]).includes(
      capabilities.Architecture,
    )
  )
    throw refused();
  if (
    image.Os !== "linux" ||
    image.Id !== KNEX_WORKER_PLATFORM_IMAGES[arch].config ||
    !Array.isArray(image.Config?.Env) ||
    !image.Config.Env.includes("NODE_VERSION=24.21.0")
  )
    throw refused();
  const revalidate = () => {
    const now = assertLocalDockerContext({
      cwd,
      inheritedEnvironment: inherited,
      ...(reviewedContext ? { context: reviewedContext } : {}),
    });
    if (
      now.context !== selection.context ||
      now.endpoint !== selection.endpoint ||
      docker(["info", "--format", "{{.ID}}"]) !== daemon
    )
      throw refused();
  };
  revalidate();
  return {
    selection,
    env,
    daemon,
    imageId: image.Id as string,
    docker,
    revalidate,
  };
};
