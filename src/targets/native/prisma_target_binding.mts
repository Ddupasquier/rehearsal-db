/** Validate the owned Docker target projection before Prisma may use its host TCP port. */
export const requirePrismaTargetBinding = (
  value: unknown,
  expected: {
    image: string;
    imageId: string;
    volume: string;
    port: number;
  },
): string => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Native target binding is unavailable.");
  const x = value as Record<string, unknown>;
  const ports =
    x.ports && typeof x.ports === "object" && !Array.isArray(x.ports)
      ? (x.ports as Record<string, unknown>)["5432/tcp"]
      : null;
  const mounts = x.mounts;
  if (
    typeof x.id !== "string" ||
    !/^[a-f0-9]{64}$/u.test(x.id) ||
    x.running !== true ||
    (x.image !== expected.image && x.image !== expected.imageId) ||
    !/^sha256:[a-f0-9]{64}$/u.test(expected.imageId) ||
    x.imageId !== expected.imageId ||
    !Array.isArray(ports) ||
    ports.length !== 1 ||
    ports[0]?.HostIp !== "127.0.0.1" ||
    ports[0]?.HostPort !== String(expected.port) ||
    !Array.isArray(mounts) ||
    mounts.length !== 1 ||
    mounts[0]?.Type !== "volume" ||
    mounts[0]?.Name !== expected.volume ||
    mounts[0]?.Destination !== "/var/lib/postgresql/data" ||
    mounts[0]?.RW !== true
  )
    throw new Error(
      "Native target image, loopback port or volume binding differs.",
    );
  return x.id;
};
