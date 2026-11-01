/** Conservative shared-image policy used by inventory and exact cleanup. */
export interface DockerImageMetadata {
  readonly Id: string;
  readonly Created?: string;
  readonly Size: number;
  readonly RepoTags?: readonly string[];
  readonly RepoDigests?: readonly string[];
}

export interface ImageCandidate {
  readonly id: string;
  readonly createdAt: string;
  readonly bytes: number;
  readonly tags: string[];
}

const repositoryFor = (tag: string): string =>
  tag.slice(0, tag.lastIndexOf(":"));
export const selectOlderUnusedSupabaseImages = ({
  images,
  usedImageIds,
}: {
  images: readonly DockerImageMetadata[];
  usedImageIds: ReadonlySet<string>;
}): ImageCandidate[] => {
  const current = new Set<string>();
  const repositories = new Map<string, DockerImageMetadata[]>();
  for (const image of images)
    for (const tag of image.RepoTags ?? []) {
      if (!tag.startsWith("public.ecr.aws/supabase/")) continue;
      const repository = repositoryFor(tag);
      repositories.set(repository, [
        ...(repositories.get(repository) ?? []),
        image,
      ]);
    }
  for (const entries of repositories.values()) {
    if (
      entries.some((image) => !Number.isFinite(Date.parse(image.Created ?? "")))
    ) {
      for (const image of entries) current.add(image.Id);
      continue;
    }
    const newest = [...entries].sort(
      (a, b) =>
        Date.parse(b.Created ?? "") - Date.parse(a.Created ?? "") ||
        [...(b.RepoTags ?? [])]
          .sort()
          .join(",")
          .localeCompare([...(a.RepoTags ?? [])].sort().join(","), "en", {
            numeric: true,
          }) ||
        a.Id.localeCompare(b.Id),
    )[0];
    if (newest) current.add(newest.Id);
  }
  return images
    .filter(
      (image) =>
        !usedImageIds.has(image.Id) &&
        !current.has(image.Id) &&
        (image.RepoTags?.length ?? 0) > 0 &&
        image.RepoTags!.every((tag) =>
          tag.startsWith("public.ecr.aws/supabase/"),
        ) &&
        Number.isFinite(Date.parse(image.Created ?? "")) &&
        Number.isFinite(image.Size) &&
        image.Size >= 0,
    )
    .map((image) => ({
      id: image.Id,
      createdAt: image.Created!,
      bytes: image.Size,
      tags: [...new Set(image.RepoTags)].sort(),
    }))
    .sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
};

export const selectImageCleanupSubset = (
  candidates: readonly ImageCandidate[],
  selectedIds?: readonly string[],
): ImageCandidate[] => {
  if (selectedIds === undefined) return [...candidates];
  if (
    !selectedIds.length ||
    selectedIds.length > 100 ||
    new Set(selectedIds).size !== selectedIds.length ||
    selectedIds.some((id) => !/^sha256:[a-f0-9]{64}$/u.test(id))
  )
    throw new Error("Select 1–100 unique full Docker image IDs.");
  const byId = new Map(
    candidates.map((candidate) => [candidate.id, candidate]),
  );
  if (selectedIds.some((id) => !byId.has(id)))
    throw new Error(
      "A selected image is no longer an eligible unused older image. Nothing was removed; refresh and preview again.",
    );
  return selectedIds
    .map((id) => byId.get(id)!)
    .sort((a, b) => a.id.localeCompare(b.id));
};
