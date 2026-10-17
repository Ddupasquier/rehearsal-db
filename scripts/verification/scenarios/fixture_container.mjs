/** Own only the standalone scenario's newly created PostgreSQL source helper. */

import { randomUUID } from "node:crypto";
import { assertLocalDockerContext } from "../../../dist/src/runtime/local_docker_context.mjs";
import { spawnScenarioCommand } from "./process.mjs";

const FIXTURE_LABEL = "com.rehearsal-db.fixture";
const ID = /^[a-f0-9]{64}$/u;
const INSPECT_FORMAT =
  '{"Id":{{json .Id}},"Name":{{json .Name}},"Labels":{{json .Config.Labels}},"Binds":{{json .HostConfig.Binds}},"ExplicitMounts":{{json (index .HostConfig "Mounts")}},"VolumesFrom":{{json .HostConfig.VolumesFrom}},"ImageVolumes":{{json .Config.Volumes}},"Mounts":{{json .Mounts}}}';
const empty = (value) =>
  value === null || (Array.isArray(value) && !value.length);
const failure = (action) =>
  new Error(
    `Standalone source fixture ${action}; no name-based fallback is allowed.`,
  );

export const createFixtureSourceContainer = ({
  cwd,
  port,
  password,
  runner = spawnScenarioCommand,
}) => {
  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    typeof password !== "string" ||
    !password ||
    /[\0\r\n]/u.test(password)
  ) {
    throw failure("requires a valid local port and synthetic password");
  }
  const nonce = randomUUID();
  const name = `rehearsal-source-${nonce}`;
  const options = { cwd, timeout: 15_000, maxBuffer: 65_536 };
  let local;
  let engineId;
  let id;
  let volumes;
  let attempted = false;
  let creationStarted = false;
  let cleaned = false;

  const execute = (args) => {
    const result = runner(
      "docker",
      ["--host", local.endpoint, ...args],
      options,
    );
    if (
      result.error ||
      result.signal ||
      result.status !== 0 ||
      typeof result.stdout !== "string" ||
      Buffer.byteLength(result.stdout) > options.maxBuffer
    ) {
      throw failure("command failed or exceeded its bounds");
    }
    return result.stdout.trim();
  };
  const context = (requestedContext) =>
    assertLocalDockerContext({
      cwd,
      context: requestedContext,
      runner: (command, args) => runner(command, args, options),
    });
  const readEngine = () => {
    const value = execute(["info", "--format", "{{.ID}}"]);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9:._-]{1,255}$/u.test(value))
      throw failure("engine identity is unavailable");
    return value;
  };
  const assertEngine = () => {
    if (
      context(local.context).identity !== local.identity ||
      readEngine() !== engineId
    ) {
      throw failure("engine identity changed");
    }
  };
  const containerPresent = () => {
    const output = execute([
      "container",
      "ls",
      "--all",
      "--quiet",
      "--no-trunc",
      "--filter",
      `id=${id}`,
    ]);
    if (output !== "" && output !== id)
      throw failure("container lookup is ambiguous");
    return output === id;
  };
  const inspectOwned = () => {
    let observed;
    try {
      observed = JSON.parse(
        execute(["container", "inspect", "--format", INSPECT_FORMAT, id]),
      );
    } catch {
      throw failure("ownership inspection failed");
    }
    if (
      observed?.Id !== id ||
      observed.Name !== `/${name}` ||
      observed.Labels?.[FIXTURE_LABEL] !== nonce ||
      Object.keys(observed.Labels).some((key) =>
        /^(?:com\.rehearsal-db\.project|com\.supabase\.cli\.project)(?:\.|$)/u.test(
          key,
        ),
      ) ||
      !empty(observed.Binds) ||
      !empty(observed.ExplicitMounts) ||
      !empty(observed.VolumesFrom) ||
      !observed.ImageVolumes ||
      Array.isArray(observed.ImageVolumes) ||
      typeof observed.ImageVolumes !== "object" ||
      !Array.isArray(observed.Mounts) ||
      observed.Mounts.length < 1 ||
      observed.Mounts.length > 8
    ) {
      throw failure("ownership or mount provenance is unproven");
    }
    const currentVolumes = observed.Mounts.map((mount) => {
      if (
        mount?.Type !== "volume" ||
        mount.Driver !== "local" ||
        !ID.test(mount.Name) ||
        typeof mount.Destination !== "string" ||
        !Object.hasOwn(observed.ImageVolumes, mount.Destination)
      ) {
        throw failure("contains an explicit or unknown data mount");
      }
      return mount.Name;
    }).sort();
    if (
      new Set(currentVolumes).size !== currentVolumes.length ||
      (volumes && JSON.stringify(currentVolumes) !== JSON.stringify(volumes))
    ) {
      throw failure("anonymous volume identity changed");
    }
    return currentVolumes;
  };
  const assertVolumesRemoved = () => {
    if (!volumes) throw failure("anonymous volume provenance was not captured");
    for (const volume of volumes) {
      if (
        execute(["volume", "ls", "--quiet", "--filter", `name=${volume}`]) !==
        ""
      ) {
        throw failure("anonymous volume remains after cleanup");
      }
    }
  };

  return Object.freeze({
    get id() {
      return id;
    },
    name,
    get endpoint() {
      return local?.endpoint;
    },
    create() {
      if (attempted) throw failure("creation was already attempted");
      attempted = true;
      local = context();
      engineId = readEngine();
      creationStarted = true;
      const created = execute([
        "container",
        "create",
        "--pull=never",
        "--name",
        name,
        "--label",
        `${FIXTURE_LABEL}=${nonce}`,
        "--publish",
        `127.0.0.1:${port}:5432`,
        "--env",
        `POSTGRES_PASSWORD=${password}`,
        "postgres:17-alpine",
      ]);
      if (!ID.test(created))
        throw failure("creation did not return one immutable ID");
      id = created;
      assertEngine();
      volumes = inspectOwned();
      return id;
    },
    start() {
      if (!id || cleaned)
        throw failure("has no active owned container to start");
      assertEngine();
      inspectOwned();
      execute(["container", "start", id]);
    },
    cleanup() {
      if (cleaned) return;
      if (!id) {
        if (creationStarted)
          throw failure("creation ownership was not established");
        return;
      }
      assertEngine();
      if (containerPresent()) {
        const observedVolumes = inspectOwned();
        volumes ??= observedVolumes;
        // Recheck the pinned engine immediately before the only deletion command.
        assertEngine();
        execute(["container", "rm", "--force", "--volumes", id]);
      }
      assertEngine();
      if (containerPresent()) throw failure("container remains after cleanup");
      assertVolumesRemoved();
      cleaned = true;
    },
  });
};

/** Keep the scenario failure while making cleanup failure impossible to hide. */
export const finishFixtureCleanup = (operationFailure, cleanupFailures) => {
  if (cleanupFailures.length) {
    throw new AggregateError(
      [...(operationFailure ? [operationFailure] : []), ...cleanupFailures],
      "Standalone fixture cleanup failed; its scratch workspace was retained.",
    );
  }
  if (operationFailure) throw operationFailure;
};
