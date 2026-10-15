import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readBoundedShapeJson } from "../../../dist/src/source/shape_json.mjs";

describe("bounded local shape JSON", () => {
  it("accepts a regular local file and rejects final/ancestor links escaping its boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "rehearsal-shape-json-"));
    try {
      const boundary = join(root, "local"),
        outside = join(root, "outside");
      await mkdir(boundary);
      await mkdir(outside);
      const local = join(boundary, "policy.json"),
        foreign = join(outside, "policy.json");
      await writeFile(local, '{"shapeVersion":1}');
      await writeFile(foreign, '{"shapeVersion":1}');
      expect(
        (await readBoundedShapeJson(local, { root: boundary })).value,
      ).toEqual({ shapeVersion: 1 });
      await symlink(local, join(boundary, "linked.json"));
      await expect(
        readBoundedShapeJson(join(boundary, "linked.json"), { root: boundary }),
      ).rejects.toThrow("symbolic link");
      await symlink(outside, join(boundary, "escaped"));
      await expect(
        readBoundedShapeJson(join(boundary, "escaped", "policy.json"), {
          root: boundary,
        }),
      ).rejects.toThrow("declared local boundary");
      await expect(
        readBoundedShapeJson(foreign, { root: boundary }),
      ).rejects.toThrow("declared local boundary");
      await symlink(boundary, join(root, "linked-root"));
      await expect(
        readBoundedShapeJson(local, { root: join(root, "linked-root") }),
      ).rejects.toThrow("boundary must not");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("refuses oversized and malformed contents without serializing JSON literals", async () => {
    const root = await mkdtemp(join(tmpdir(), "rehearsal-shape-json-"));
    try {
      const path = join(root, "policy.json");
      await writeFile(path, "SECRET_JSON_CANARY:{");
      try {
        await readBoundedShapeJson(path, { root });
        throw new Error("Expected invalid JSON refusal");
      } catch (error) {
        expect(error.message).toContain("no source value was printed");
        expect(error.message).not.toContain("SECRET_JSON_CANARY");
      }
      await writeFile(path, Buffer.alloc(1024 * 1024 + 1));
      await expect(readBoundedShapeJson(path, { root })).rejects.toThrow(
        "bounded regular file",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
