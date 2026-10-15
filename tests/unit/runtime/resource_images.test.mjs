import { describe, it, expect } from "vitest";
import {
  selectOlderUnusedSupabaseImages,
  selectImageCleanupSubset,
} from "../../../dist/src/runtime/resource_images.mjs";
const id = (n) => `sha256:${String(n).repeat(64)}`;
const image = (n, tag, date = "2026-10-01T00:00:00Z") => ({
  Id: id(n),
  RepoTags: [`public.ecr.aws/supabase/postgres:${tag}`],
  Created: date,
  Size: n * 100,
});
describe("exact image selection", () => {
  it("preserves all versions when an image format omits creation time", () => {
    const images = [
      image(1, "old"),
      {
        Id: id(2),
        RepoTags: ["public.ecr.aws/supabase/postgres:new"],
        Size: 100,
      },
    ];
    expect(
      selectOlderUnusedSupabaseImages({ images, usedImageIds: new Set() }),
    ).toEqual([]);
  });
  it("retains current versions and images used by stopped or running containers", () => {
    const images = [
      image(1, "17.1", "2026-09-01T00:00:00Z"),
      image(2, "17.2", "2026-09-02T00:00:00Z"),
      image(3, "17.3"),
    ];
    expect(
      selectOlderUnusedSupabaseImages({
        images,
        usedImageIds: new Set([id(2)]),
      }).map((i) => i.id),
    ).toEqual([id(1)]);
  });
  it("protects an image current in any service repository and any outside-policy alias", () => {
    const images = [
      {
        ...image(1, "old", "2026-09-01T00:00:00Z"),
        RepoTags: [
          "public.ecr.aws/supabase/postgres:old",
          "private-project/db:keep",
        ],
      },
      image(2, "new"),
    ];
    expect(
      selectOlderUnusedSupabaseImages({ images, usedImageIds: new Set() }),
    ).toEqual([]);
    images[0].RepoTags = [
      "public.ecr.aws/supabase/postgres:old",
      "public.ecr.aws/supabase/storage:latest",
    ];
    expect(
      selectOlderUnusedSupabaseImages({ images, usedImageIds: new Set() }),
    ).toEqual([]);
  });
  it("binds selection to complete unique IDs and refuses stale or ineligible subsets", () => {
    const candidates = [
      {
        id: id(1),
        tags: ["public.ecr.aws/supabase/postgres:old"],
        bytes: 10,
        createdAt: "2026-09-01T00:00:00Z",
      },
    ];
    expect(selectImageCleanupSubset(candidates, [id(1)])).toEqual(candidates);
    for (const selection of [
      [],
      [id(1), id(1)],
      ["short-id"],
      ["--force"],
      [id(2)],
    ])
      expect(() => selectImageCleanupSubset(candidates, selection)).toThrow();
  });
});
