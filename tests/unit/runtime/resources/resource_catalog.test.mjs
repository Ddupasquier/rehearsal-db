import { describe, it, expect } from "vitest";
import { buildResourceCatalog } from "../../../../dist/src/runtime/resources/resource_catalog.mjs";
const imageId = `sha256:${"a".repeat(64)}`;
const container = (id, project, running) => ({
  Id: id,
  Name: `/${id}`,
  Image: imageId,
  Config: {
    Labels: { "com.rehearsal-db.project": project },
    Env: ["SECRET=never-export"],
  },
  State: { Running: running, FinishedAt: "2026-10-12T00:00:00Z" },
  Mounts: [
    { Type: "volume", Name: "db", Destination: "/var/lib/postgresql/data" },
  ],
});
const input = {
  targets: [
    {
      name: "primary",
      projectId: "test-rehearsal",
      provider: "postgresql",
      protected: true,
    },
  ],
  volumes: [
    {
      Name: "db",
      Labels: { "com.rehearsal-db.project": "test-rehearsal" },
      CreatedAt: "2026-10-01T00:00:00Z",
    },
  ],
  volumeSizes: new Map([["db", 123]]),
  images: [
    {
      Id: imageId,
      Created: "2026-10-01T00:00:00Z",
      Size: 20,
      RepoTags: ["public.ecr.aws/supabase/postgres:old"],
    },
  ],
};
describe("resource catalog", () => {
  it("does not label a known-age version current when a sibling image has unknown age", () => {
    const catalog = buildResourceCatalog({
      ...input,
      containers: [],
      images: [
        input.images[0],
        {
          Id: `sha256:${"b".repeat(64)}`,
          Size: 20,
          RepoTags: ["public.ecr.aws/supabase/postgres:new"],
        },
      ],
    });
    expect(catalog.images[0].state).toBe("outside-policy");
    expect(catalog.images[0].reason).toContain("cannot be proven");
  });
  it("reports an OCI index's unknown creation time without guessing age or eligibility", () => {
    const catalog = buildResourceCatalog({
      ...input,
      containers: [],
      images: [{ Id: imageId, Size: 6376, RepoTags: ["node:24-bookworm"] }],
    });
    expect(catalog.images[0]).toMatchObject({
      createdAt: null,
      state: "outside-policy",
    });
    expect(catalog.images[0].reason).toContain("cannot be proven");
  });
  it("lists stopped references, proven mount purpose and protection without leaking environment values", () => {
    const catalog = buildResourceCatalog({
      ...input,
      containers: [
        container("sandbox", "test-rehearsal", false),
        container("other", "another-project", true),
      ],
    });
    expect(catalog.images[0]).toMatchObject({
      state: "in-use",
      references: [
        { name: "sandbox", running: false, ownership: "project" },
        { name: "other", running: true, ownership: "other" },
      ],
    });
    expect(catalog.volumes[0]).toMatchObject({
      target: "primary",
      ownership: "project",
      purpose: "database",
      state: "attached",
      protected: true,
      bytes: 123,
      lastActivityAt: "2026-10-12T00:00:00Z",
    });
    expect(catalog.otherContainers).toHaveLength(1);
    expect(JSON.stringify(catalog)).not.toContain("never-export");
  });
  it("keeps conflicting ownership outside project control and rejects missing image references", () => {
    const c = container("conflict", "test-rehearsal", false);
    c.Config.Labels["com.supabase.cli.project"] = "foreign";
    expect(
      buildResourceCatalog({ ...input, containers: [c] }).otherContainers[0]
        .ownership,
    ).toBe("conflicting");
    expect(() =>
      buildResourceCatalog({
        ...input,
        containers: [{ Id: "broken", State: { Running: false } }],
      }),
    ).toThrow("incomplete");
  });
});
