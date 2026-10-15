/** Bounded, read-only resource metadata; no environment values or database rows. */
import { selectOlderUnusedSupabaseImages } from "./resource_images.mjs";
import type { DockerImageMetadata } from "./resource_images.mjs";
import type { SpawnSyncReturns } from "node:child_process";

export interface CatalogContainer {
  readonly Id?: string;
  readonly Name?: string;
  readonly Image?: string;
  readonly Created?: string;
  readonly Config?: { readonly Labels?: Record<string, string> | null };
  readonly State?: {
    readonly Running?: boolean;
    readonly StartedAt?: string;
    readonly FinishedAt?: string;
  };
  readonly Mounts?: readonly {
    readonly Type?: string;
    readonly Name?: string;
    readonly Destination?: string;
  }[];
}
export interface CatalogVolume {
  readonly Name?: string;
  readonly CreatedAt?: string;
  readonly Labels?: Record<string, string> | null;
}
interface CatalogTarget {
  readonly name: string;
  readonly projectId: string;
  readonly provider: "supabase" | "postgresql";
  readonly protected: boolean;
}
export interface ResourceCatalog {
  readonly schemaVersion: 1;
  readonly images: readonly {
    readonly id: string;
    readonly service: string;
    readonly tags: readonly string[];
    readonly digests: readonly string[];
    readonly createdAt: string | null;
    readonly bytes: number;
    readonly state: "candidate" | "in-use" | "current" | "outside-policy";
    readonly reason: string;
    readonly references: readonly {
      readonly id: string;
      readonly name: string;
      readonly running: boolean;
      readonly ownership: "project" | "other";
    }[];
  }[];
  readonly volumes: readonly {
    readonly name: string;
    readonly target: string | null;
    readonly ownership: "project" | "other" | "conflicting";
    readonly purpose: "database" | "storage" | "unknown";
    readonly bytes: number | null;
    readonly createdAt: string | null;
    readonly lastActivityAt: string | null;
    readonly state: "attached" | "detached";
    readonly protected: boolean;
    readonly containerCount: number;
    readonly reason: string;
  }[];
  readonly otherContainers: readonly {
    readonly id: string;
    readonly name: string;
    readonly running: boolean;
    readonly ownership: "other" | "conflicting";
    readonly reason: string;
  }[];
}
const text = (value: string | undefined, fallback: string): string =>
  (value || fallback).slice(0, 500).replace(/[\r\n\0]/gu, " ");
const owner = (
  labels: Record<string, string> | null | undefined,
  targets: readonly CatalogTarget[],
): CatalogTarget | "conflicting" | null => {
  const names = labels ?? {};
  const matches = targets.filter(
    (target) =>
      names[
        target.provider === "supabase"
          ? "com.supabase.cli.project"
          : "com.rehearsal-db.project"
      ] === target.projectId,
  );
  if (!matches.length) return null;
  const match = matches[0]!;
  const values = [
    names["com.supabase.cli.project"],
    names["com.rehearsal-db.project"],
  ].filter(Boolean);
  return matches.length !== 1 ||
    values.some((value) => value !== match.projectId)
    ? "conflicting"
    : match;
};
const timestamp = (value?: string): string | null =>
  value && Number.isFinite(Date.parse(value)) ? value : null;
export const buildResourceCatalog = ({
  containers,
  volumes,
  images,
  targets,
  volumeSizes,
}: {
  containers: readonly CatalogContainer[];
  volumes: readonly CatalogVolume[];
  images: readonly DockerImageMetadata[];
  targets: readonly CatalogTarget[];
  volumeSizes: ReadonlyMap<string, number>;
}): ResourceCatalog => {
  if (containers.length > 1000 || volumes.length > 1000 || images.length > 1000)
    throw new Error(
      "Local resource inventory exceeds its 1000-item bound. No resources were changed.",
    );
  if (
    containers.some(
      (container) =>
        !container.Id ||
        !container.Image ||
        !/^sha256:[a-f0-9]{64}$/u.test(container.Image) ||
        typeof container.State?.Running !== "boolean",
    )
  )
    throw new Error(
      "Container image references are incomplete. No cleanup eligibility can be proven.",
    );
  const used = new Set(containers.flatMap((c) => (c.Image ? [c.Image] : [])));
  const eligible = new Set(
    selectOlderUnusedSupabaseImages({ images, usedImageIds: used }).map(
      (i) => i.id,
    ),
  );
  const unknownAgeRepositories = new Set(
    images
      .filter((image) => timestamp(image.Created) === null)
      .flatMap((image) =>
        (image.RepoTags ?? []).map((tag) => tag.slice(0, tag.lastIndexOf(":"))),
      ),
  );
  return {
    schemaVersion: 1,
    images: images
      .map((image) => {
        const references = containers
          .filter((c) => c.Image === image.Id)
          .map((c) => ({
            id: text(c.Id, "unknown"),
            name: text(
              c.Name?.replace(/^\//u, ""),
              c.Id?.slice(0, 12) ?? "Unknown container",
            ),
            running: c.State?.Running === true,
            ownership:
              owner(c.Config?.Labels, targets) &&
              owner(c.Config?.Labels, targets) !== "conflicting"
                ? ("project" as const)
                : ("other" as const),
          }));
        const tags = [...new Set(image.RepoTags ?? [])].sort();
        const createdAt = timestamp(image.Created);
        const unknownAgePeer = tags.some((tag) =>
          unknownAgeRepositories.has(tag.slice(0, tag.lastIndexOf(":"))),
        );
        const state = references.length
          ? ("in-use" as const)
          : eligible.has(image.Id)
            ? ("candidate" as const)
            : createdAt !== null &&
                !unknownAgePeer &&
                tags.length &&
                tags.every((t) => t.startsWith("public.ecr.aws/supabase/"))
              ? ("current" as const)
              : ("outside-policy" as const);
        return {
          id: image.Id,
          service: text(
            tags[0]?.split("/").at(-1)?.split(":")[0],
            "Untagged image",
          ),
          tags,
          digests: [...(image.RepoDigests ?? [])].sort(),
          createdAt,
          bytes: image.Size,
          state,
          references,
          reason:
            state === "in-use"
              ? "Referenced by a running or stopped container. Remove it only through that environment's reviewed workflow."
              : state === "candidate"
                ? "Older official Supabase image, with no container references. Eligible for exact-preview cleanup."
                : state === "current"
                  ? "Newest cached service image is retained for reuse."
                  : createdAt === null
                    ? "Creation time is not reported by this image format, so age and cleanup eligibility cannot be proven. Read only."
                    : unknownAgePeer
                      ? "Another cached version has no creation time, so version age and cleanup eligibility cannot be proven. Read only."
                      : "Outside Rehearsal's shared-image cleanup policy. Read only.",
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id)),
    volumes: volumes
      .map((volume) => {
        const ownership = owner(volume.Labels, targets);
        const attached = containers.filter((c) =>
          c.Mounts?.some((m) => m.Type === "volume" && m.Name === volume.Name),
        );
        const destinations = attached.flatMap(
          (c) =>
            c.Mounts?.filter((m) => m.Name === volume.Name).map(
              (m) => m.Destination ?? "",
            ) ?? [],
        );
        const purpose = destinations.some((d) =>
          d.startsWith("/var/lib/postgresql"),
        )
          ? ("database" as const)
          : destinations.some((d) => d.startsWith("/var/lib/storage"))
            ? ("storage" as const)
            : ("unknown" as const);
        const target =
          ownership && ownership !== "conflicting" ? ownership : null;
        const dates = attached
          .flatMap((c) => [
            timestamp(c.State?.StartedAt),
            timestamp(c.State?.FinishedAt),
          ])
          .filter((d): d is string => Boolean(d))
          .sort((a, b) => Date.parse(b) - Date.parse(a));
        return {
          name: text(volume.Name, "unknown"),
          target: target?.name ?? null,
          ownership:
            ownership === "conflicting"
              ? ("conflicting" as const)
              : target
                ? ("project" as const)
                : ("other" as const),
          purpose,
          bytes: volume.Name ? (volumeSizes.get(volume.Name) ?? null) : null,
          createdAt: timestamp(volume.CreatedAt),
          lastActivityAt: dates[0] ?? null,
          state: attached.length
            ? ("attached" as const)
            : ("detached" as const),
          protected: target?.protected ?? true,
          containerCount: attached.length,
          reason: target
            ? target.protected
              ? "Owning environment is protected. Unprotect it before a reviewed discard."
              : "Persistent data. Individual deletion is disabled; use the owning environment's reviewed discard."
            : "Ownership is outside this project or conflicting. Rehearsal will not delete this volume.",
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
    otherContainers: containers
      .filter(
        (c) =>
          !owner(c.Config?.Labels, targets) ||
          owner(c.Config?.Labels, targets) === "conflicting",
      )
      .map((c) => ({
        id: text(c.Id, "unknown"),
        name: text(
          c.Name?.replace(/^\//u, ""),
          c.Id?.slice(0, 12) ?? "Unknown container",
        ),
        running: c.State?.Running === true,
        ownership:
          owner(c.Config?.Labels, targets) === "conflicting"
            ? ("conflicting" as const)
            : ("other" as const),
        reason:
          "Not proven to belong to this project. Read only; use its owning project's tools.",
      })),
  };
};
export const inspectCatalogImages = (
  run: (
    command: string,
    args: readonly string[],
    cwd: string,
  ) => SpawnSyncReturns<string>,
  cwd: string,
): readonly DockerImageMetadata[] => {
  const listing = run("docker", ["image", "ls", "--quiet", "--no-trunc"], cwd);
  if (listing.status !== 0)
    throw new Error(
      "Docker image inventory is unavailable. No resources were changed.",
    );
  const ids = [...new Set(listing.stdout.trim().split(/\s+/u).filter(Boolean))];
  if (ids.length > 1000)
    throw new Error("Docker image inventory exceeds its 1000-image bound.");
  if (!ids.length) return [];
  const result = run("docker", ["image", "inspect", ...ids], cwd);
  if (result.status !== 0)
    throw new Error(
      "Docker images changed during inspection. Refresh the resource inventory.",
    );
  const images: unknown = JSON.parse(result.stdout);
  if (!Array.isArray(images) || images.length !== ids.length)
    throw new Error("Docker image inventory is incomplete.");
  return images.map((image: DockerImageMetadata) => {
    if (
      !/^sha256:[a-f0-9]{64}$/u.test(image.Id) ||
      !Number.isFinite(image.Size) ||
      image.Size < 0 ||
      (image.Created !== undefined &&
        image.Created !== null &&
        !timestamp(image.Created)) ||
      (image.RepoTags?.length ?? 0) > 100 ||
      (image.RepoDigests?.length ?? 0) > 100
    )
      throw new Error("Docker image metadata is invalid.");
    return image;
  });
};
