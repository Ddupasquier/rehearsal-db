/** Inspect actual worker isolation before dispatch and every owned mutation. */
export interface KnexWorkerExpectation {
  fullId: string;
  imageId: string;
  labels: Readonly<Record<string, string>>;
  mounts: readonly { source: string; destination: string }[];
}
export const assertKnexWorkerIsolation = (
  value: unknown,
  expected: KnexWorkerExpectation,
) => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Worker isolation is unverified.");
  const r = value as Record<string, any>,
    h = r.HostConfig,
    c = r.Config,
    id = expected.fullId,
    image = { Id: expected.imageId },
    labels = expected.labels,
    mounts = expected.mounts;
  if (
    r.Id !== id ||
    r.Image !== image.Id ||
    c?.User !== "65532:65532" ||
    c?.Tty !== false ||
    !Object.entries(labels).every(([k, v]) => c?.Labels?.[k] === v) ||
    h?.NetworkMode !== "none" ||
    h?.ReadonlyRootfs !== true ||
    h?.Privileged !== false ||
    h?.PublishAllPorts !== false ||
    (h?.CapAdd?.length ?? 0) !== 0 ||
    (h?.Devices?.length ?? 0) !== 0 ||
    (h?.DeviceRequests?.length ?? 0) !== 0 ||
    h?.CgroupnsMode !== "private" ||
    h?.PidMode !== "" ||
    h?.IpcMode !== "private" ||
    h?.Memory !== 268435456 ||
    h?.MemorySwap !== 268435456 ||
    h?.NanoCpus !== 1000000000 ||
    h?.PidsLimit !== 32 ||
    h?.LogConfig?.Type !== "none" ||
    h?.RestartPolicy?.Name !== "no" ||
    !Array.isArray(h?.CapDrop) ||
    h.CapDrop.length !== 1 ||
    h.CapDrop[0] !== "ALL" ||
    !Array.isArray(h?.SecurityOpt) ||
    h.SecurityOpt.length !== 1 ||
    !["no-new-privileges", "no-new-privileges:true"].includes(
      h.SecurityOpt[0],
    ) ||
    Object.keys(h.PortBindings ?? {}).length ||
    !Array.isArray(r.Mounts) ||
    (r.Mounts.length !== 3 && r.Mounts.length !== 4) ||
    r.Mounts.filter((x: { Type: string }) => x.Type === "bind").length !== 3 ||
    r.Mounts.some(
      (x: { Type: string; Destination: string }) =>
        x.Type !== "bind" && !(x.Type === "tmpfs" && x.Destination === "/tmp"),
    ) ||
    !mounts.every((m) =>
      r.Mounts.some(
        (x: {
          Type: string;
          Source: string;
          Destination: string;
          RW: boolean;
          Propagation: string;
        }) =>
          x.Type === "bind" &&
          x.Source === m.source &&
          x.Destination === m.destination &&
          x.RW === false &&
          x.Propagation === "rprivate",
      ),
    ) ||
    Object.keys(h.Tmpfs ?? {}).length !== 1 ||
    h.Tmpfs["/tmp"] !== "rw,noexec,nosuid,nodev,size=67108864,mode=1777"
  )
    throw new Error("Worker isolation is unverified.");
  if (
    typeof r.State?.Running !== "boolean" ||
    !["created", "running", "exited"].includes(r.State.Status) ||
    JSON.stringify(c.Entrypoint) !== JSON.stringify(["/usr/local/bin/node"]) ||
    JSON.stringify(c.Cmd) !== JSON.stringify(["/runner/bootstrap.mjs"]) ||
    c.OpenStdin !== true
  )
    throw new Error("Worker isolation is unverified.");
  return {
    State: {
      Running: r.State.Running as boolean,
      Status: r.State.Status as string,
    },
  };
};
