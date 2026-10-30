import { expect, it } from "vitest";
import { requirePrismaTargetBinding } from "../../../dist/src/targets/prisma_target_binding.mjs";
const expected = {
  image: "postgres:17-alpine",
  imageId: "sha256:" + "a".repeat(64),
  volume: "owned-postgresql-data",
  port: 54322,
};
const projection = () => ({
  id: "b".repeat(64),
  running: true,
  image: expected.image,
  imageId: expected.imageId,
  ports: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "54322" }] },
  mounts: [
    {
      Type: "volume",
      Name: expected.volume,
      Destination: "/var/lib/postgresql/data",
      RW: true,
    },
  ],
});
it("permits host SQL only for the exact running image, loopback publication and owned data volume", () => {
  expect(requirePrismaTargetBinding(projection(), expected)).toBe(
    "b".repeat(64),
  );
});
it("accepts a retained shell recreated from the same immutable resolved image ID", () => {
  const x = projection();
  x.image = expected.imageId;
  expect(requirePrismaTargetBinding(x, expected)).toBe(x.id);
  x.imageId = "sha256:" + "c".repeat(64);
  expect(() => requirePrismaTargetBinding(x, expected)).toThrow();
});
it.each([
  (x) => {
    x.running = false;
  },
  (x) => {
    x.id = "short";
  },
  (x) => {
    x.image = "postgres:16-alpine";
  },
  (x) => {
    x.imageId = "sha256:" + "c".repeat(64);
  },
  (x) => {
    x.ports["5432/tcp"][0].HostIp = "0.0.0.0";
  },
  (x) => {
    x.ports["5432/tcp"][0].HostPort = "54323";
  },
  (x) => {
    x.ports["5432/tcp"].push({ HostIp: "::", HostPort: "54322" });
  },
  (x) => {
    x.ports = {};
  },
  (x) => {
    x.mounts[0].Name = "foreign-data";
  },
  (x) => {
    x.mounts[0].Type = "bind";
  },
  (x) => {
    x.mounts[0].Destination = "/wrong";
  },
  (x) => {
    x.mounts[0].RW = false;
  },
  (x) => {
    x.mounts.push({ Type: "bind", Destination: "/extra" });
  },
])(
  "refuses mismatched or ambiguous native TCP target evidence (%#)",
  (change) => {
    const x = projection();
    change(x);
    expect(() => requirePrismaTargetBinding(x, expected)).toThrow();
  },
);
