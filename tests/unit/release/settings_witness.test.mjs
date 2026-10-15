import { constants } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const filesystem = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("node:fs/promises", () => ({ open: filesystem.open }));

import { createControlsWitness } from "../../../scripts/release/controls_witness.mjs";
import {
  controlsWitnessUrl,
  readControlsWitness,
} from "../../../scripts/release/settings_witness.mjs";

const validWitness = () =>
  createControlsWitness({
    repository: "Ddupasquier/rehearsal-db",
    repositoryId: 123,
    ownerId: 456,
    environmentId: 789,
    observedAt: "2026-10-15T18:00:33.000Z",
    rulesets: [
      [11, "branch", "refs/heads/main"],
      [12, "tag", "refs/tags/v*"],
    ].map(([id, target, reference]) => ({
      id,
      target,
      source_type: "Repository",
      source: "Ddupasquier/rehearsal-db",
      enforcement: "active",
      bypass_actors: [],
      created_at: "2026-10-15T11:00:30.555-07:00",
      updated_at: "2026-10-15T11:00:30.630-07:00",
      conditions: { ref_name: { include: [reference], exclude: [] } },
      rules: [{ type: "deletion" }],
    })),
  });

function file(contents = JSON.stringify(validWitness())) {
  const bytes = Buffer.from(contents);
  const handle = {
    stat: vi.fn(async () => ({ size: bytes.length, isFile: () => true })),
    read: vi.fn(async (buffer, offset, length, position) => {
      const bytesRead = bytes.copy(
        buffer,
        offset,
        position,
        Math.min(bytes.length, position + length),
      );
      return { bytesRead, buffer };
    }),
    close: vi.fn(async () => {}),
  };
  filesystem.open.mockResolvedValue(handle);
  return handle;
}

afterEach(() => vi.resetAllMocks());

describe("bounded repository-local release witness reader", () => {
  it("reads a valid witness only from the fixed repository URL with no-follow/nonblocking flags", async () => {
    const handle = file();
    const result = await readControlsWitness();
    expect(result).toEqual(validWitness());
    expect(controlsWitnessUrl.href).toBe(
      new URL("../../../.github/release-controls.json", import.meta.url).href,
    );
    expect(filesystem.open).toHaveBeenCalledExactlyOnceWith(
      controlsWitnessUrl,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    expect(handle.stat).toHaveBeenCalledOnce();
    expect(handle.read).toHaveBeenCalledExactlyOnceWith(
      expect.any(Buffer),
      0,
      16_385,
      0,
    );
    expect(handle.read.mock.calls[0][0].length).toBe(16_385);
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it("accepts the exact 16 KiB boundary without reading another block", async () => {
    const json = JSON.stringify(validWitness());
    const handle = file(json + " ".repeat(16_384 - Buffer.byteLength(json)));
    expect(await readControlsWitness()).toEqual(validWitness());
    expect(handle.read).toHaveBeenCalledOnce();
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it.each([0, -1, 16_385, 1_000_000_000])(
    "refuses a regular file with invalid stated size %i before reading and closes it",
    async (size) => {
      const handle = file();
      handle.stat.mockResolvedValue({ size, isFile: () => true });
      await expect(readControlsWitness()).rejects.toThrow("invalid_file");
      expect(handle.read).not.toHaveBeenCalled();
      expect(handle.close).toHaveBeenCalledOnce();
    },
  );

  it("refuses a nonregular handle before reading, including a nonblocking FIFO/directory", async () => {
    const handle = file();
    handle.stat.mockResolvedValue({ size: 100, isFile: () => false });
    await expect(readControlsWitness()).rejects.toThrow("invalid_file");
    expect(handle.read).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it("detects growth after stat with a single bounded overflow-byte read and closes the handle", async () => {
    const handle = file(" ".repeat(16_385));
    handle.stat.mockResolvedValue({ size: 100, isFile: () => true });
    await expect(readControlsWitness()).rejects.toThrow("file_bound");
    expect(handle.read).toHaveBeenCalledOnce();
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it.each(["not JSON", "{", "", '{"schemaVersion": 1}'])(
    "closes the handle when JSON or witness validation refuses %j",
    async (contents) => {
      const handle = file(contents);
      handle.stat.mockResolvedValue({ size: 100, isFile: () => true });
      await expect(readControlsWitness()).rejects.toThrow();
      expect(handle.read).toHaveBeenCalledOnce();
      expect(handle.close).toHaveBeenCalledOnce();
    },
  );

  it("rejects unknown fields in an otherwise valid witness without accepting private payload", async () => {
    const handle = file(
      JSON.stringify({ ...validWitness(), privateToken: "private-canary" }),
    );
    await expect(readControlsWitness()).rejects.toThrow("unexpected_fields");
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it.each(["stat", "read"])(
    "closes the handle after an injected %s failure without retrying",
    async (operation) => {
      const handle = file();
      const failure = new Error("synthetic I/O failure");
      handle[operation].mockRejectedValue(failure);
      await expect(readControlsWitness()).rejects.toBe(failure);
      expect(filesystem.open).toHaveBeenCalledOnce();
      expect(handle[operation]).toHaveBeenCalledOnce();
      if (operation === "stat") expect(handle.read).not.toHaveBeenCalled();
      expect(handle.close).toHaveBeenCalledOnce();
    },
  );

  it("propagates a no-follow/open refusal without attempting a read or closing an unacquired handle", async () => {
    const handle = file();
    const failure = new Error("synthetic ELOOP refusal");
    filesystem.open.mockRejectedValue(failure);
    await expect(readControlsWitness()).rejects.toBe(failure);
    expect(filesystem.open).toHaveBeenCalledOnce();
    expect(handle.stat).not.toHaveBeenCalled();
    expect(handle.read).not.toHaveBeenCalled();
    expect(handle.close).not.toHaveBeenCalled();
  });
});
