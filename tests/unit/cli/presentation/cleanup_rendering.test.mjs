import { describe, expect, it } from "vitest";
import {
  formatBytes,
  renderCleanup,
} from "../../../../dist/src/cli/presentation/cleanup_rendering.mjs";
import { renderCleanup as legacyRenderCleanup } from "../../../../dist/src/cli/presentation/renderers.mjs";

const digest = "a".repeat(64);
const target = () => ({
  project: "synthetic-project",
  projectId: "synthetic-project",
  baselines: { available: true, removed: ["old"], retained: ["current"] },
  runtime: { included: true, detected: true },
  images: {
    requested: true,
    inspected: true,
    candidates: [{ bytes: 2048, tags: ["synthetic/image:old"] }],
  },
});
const plan = () => ({
  ...target(),
  digest,
  docker: {
    resources: [{ Type: "Images", Size: "4 KiB", Reclaimable: "2 KiB" }],
    disk: {
      usedBytes: 2048,
      totalBytes: 4096,
      availableBytes: 2048,
      usedPercent: 50,
    },
  },
});

describe("cleanup presentation", () => {
  it("keeps the existing renderer entry and makes a selected preview require exact confirmation", () => {
    expect(legacyRenderCleanup).toBe(renderCleanup);
    const current = plan();
    const before = structuredClone(current);
    const output = renderCleanup({ mode: "preview", plan: current });
    expect(output).toContain("REHEARSAL CLEANUP — PREVIEW");
    expect(output).toContain("Nothing has been removed.");
    expect(output).toContain(`Exact confirmation: --confirm-cleanup=${digest}`);
    expect(output).toContain("Current project runtime selected");
    expect(output).toContain(
      "2.0 KiB used of 4.0 KiB; 2.0 KiB free (50% used)",
    );
    expect(output).not.toContain("Removed this project's disposable runtime");
    expect(current).toEqual(before);
  });

  it("reports unavailable inspection and an empty selection without inventing a removal or confirmation", () => {
    const current = plan();
    current.baselines = { available: false, removed: [], retained: [] };
    current.runtime = { included: false, detected: false };
    current.images = { requested: true, inspected: false, candidates: [] };
    current.docker.resources = [
      null,
      {},
      { Type: "Images", Size: 1, Reclaimable: [] },
    ];
    current.docker.disk = null;
    const output = renderCleanup({ mode: "preview", plan: current });
    expect(output).toContain("Docker usage: unavailable");
    expect(output).toContain("No active baseline found");
    expect(output).toContain("No runtime found");
    expect(output).toContain(
      "Docker is unavailable; images could not be inspected",
    );
    expect(output).toContain(
      "Nothing has been removed, and nothing is currently selected.",
    );
    expect(output).not.toContain("Exact confirmation:");
  });

  it("reports actual applied outcomes and preserves a runtime that was selected but not removed", () => {
    const output = renderCleanup({
      mode: "written",
      plan: plan(),
      applied: {
        baselines: { removed: ["old-one", "old-two"] },
        runtimeRemoved: false,
        imagesRemoved: ["synthetic/image:old"],
      },
    });
    expect(output).toContain("REHEARSAL CLEANUP — WRITTEN");
    expect(output).toContain("Removed 2 old baseline generations.");
    expect(output).toContain("Preserved this project's disposable runtime.");
    expect(output).toContain("Removed 1 unused image tag.");
    expect(output).not.toContain(
      "Removed this project's disposable runtime and volumes.",
    );
    expect(output).not.toContain("Exact confirmation:");
  });

  it("keeps stack confirmation combined while reporting each target's applied preservation outcome", () => {
    const current = {
      targets: [
        { name: "first", plan: target() },
        {
          name: "second",
          plan: { ...target(), runtime: { included: false, detected: true } },
        },
      ],
      digest,
    };
    const preview = renderCleanup({ mode: "preview", plan: current });
    expect(preview).toContain("REHEARSAL STACK CLEANUP — PREVIEW");
    expect(preview).toContain(`Combined cleanup set: ${digest.slice(0, 12)}`);
    expect(preview).toContain(
      `Exact confirmation: --confirm-cleanup=${digest}`,
    );
    expect(preview).toContain("Nothing has been removed.");
    const applied = renderCleanup({
      mode: "written",
      plan: current,
      applied: {
        targets: [
          {
            name: "first",
            applied: {
              baselines: { removed: ["old"] },
              runtimeRemoved: true,
              imagesRemoved: [],
            },
          },
          {
            name: "second",
            applied: {
              baselines: { removed: [] },
              runtimeRemoved: false,
              imagesRemoved: ["synthetic/image:old"],
            },
          },
        ],
      },
    });
    expect(applied).toContain(
      "first: removed 1 old baseline generation; runtime removed; removed 0 unused image tags.",
    );
    expect(applied).toContain(
      "second: removed 0 old baseline generations; runtime preserved; removed 1 unused image tag.",
    );
    expect(applied).not.toContain("Exact confirmation:");
  });

  it.each([
    [Number.NaN, "0 B"],
    [Number.POSITIVE_INFINITY, "0 B"],
    [-1, "0 B"],
    [0, "0 B"],
    [1, "1 B"],
    [1024, "1.0 KiB"],
    [10240, "10 KiB"],
  ])("formats the byte boundary %s as %s", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});
