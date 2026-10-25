import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { readContainerRetirementClaims } from "../../../dist/src/cli/container_command_handlers.mjs";
const roots = [];
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "retirement-claims-"));
  roots.push(root);
  return root;
};
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
describe("explicit completed container claims", () => {
  it("reads only a versioned regular request without evaluating project code", async () => {
    const root = await fixture(),
      path = join(root, "claims.json"),
      claims = [
        {
          fullId: "a".repeat(64),
          expectedLabels: { "com.rehearsal-db.project": "owned" },
          completedDisposable: true,
        },
      ];
    await writeFile(path, JSON.stringify({ schemaVersion: 1, claims }));
    expect(await readContainerRetirementClaims(path)).toEqual(claims);
  });
  it("refuses oversized, malformed, unversioned and extra-field requests", async () => {
    const root = await fixture(),
      path = join(root, "claims.json");
    for (const text of [
      "x".repeat(65537),
      "{bad",
      JSON.stringify({ claims: [] }),
      JSON.stringify({
        schemaVersion: 1,
        claims: [],
        secret: "not interpreted",
      }),
    ]) {
      await writeFile(path, text);
      await expect(readContainerRetirementClaims(path)).rejects.toThrow();
    }
  });
  it("refuses symlinks and nonregular FIFO inputs without blocking", async () => {
    const root = await fixture(),
      regular = join(root, "regular.json"),
      link = join(root, "link.json"),
      fifo = join(root, "fifo");
    await writeFile(regular, JSON.stringify({ schemaVersion: 1, claims: [] }));
    await symlink(regular, link);
    await expect(readContainerRetirementClaims(link)).rejects.toThrow();
    if (process.platform !== "win32") {
      execFileSync("mkfifo", [fifo]);
      await expect(readContainerRetirementClaims(fifo)).rejects.toThrow(
        /regular/,
      );
    }
  });
});
