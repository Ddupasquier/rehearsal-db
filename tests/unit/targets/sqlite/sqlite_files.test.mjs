import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  sqliteFileIdentity,
  assertSqliteFile,
  sqliteOwnedDirectory,
  sqliteProjectPath,
  readSqliteBytes,
  readSqliteJson,
  writeSqliteJson,
  sameSqliteIdentity,
} from "../../../../dist/src/targets/sqlite/sqlite_files.mjs";
import {
  serializeRehearsalError,
  renderHumanError,
} from "../../../../dist/src/shared/diagnostics.mjs";
const roots = [];
const fixture = () => {
  const root = fs.mkdtempSync(join(tmpdir(), "sqlite-files-"));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
const config = { runtime: { projectId: "sqlite-files-test" } };
describe("SQLite file ownership boundaries", () => {
  it("does not expose malformed private JSON excerpts through either error renderer", () => {
    const root = fixture(),
      path = join(root, "owner.json"),
      canary = "PRIVATE_SQLITE_NOTE_7291";
    fs.writeFileSync(path, `{"note":"${canary}",invalid}`);
    let error;
    try {
      readSqliteJson(path);
    } catch (caught) {
      error = caught;
    }
    expect(error?.code).toBe("SQLITE_INPUT_INVALID");
    expect(JSON.stringify(serializeRehearsalError(error))).not.toContain(
      canary,
    );
    expect(renderHumanError(error)).not.toContain(canary);
    expect(fs.readFileSync(path, "utf8")).toContain(canary);
    fs.writeFileSync(path, Buffer.from([0x22, 0xff, 0x22]));
    expect(() => readSqliteJson(path)).toThrow("not valid JSON");
  });
  it("preserves dangling metadata links and their unrelated target", () => {
    const root = fixture(),
      target = join(root, "missing.json"),
      path = join(root, "active.json");
    fs.symlinkSync(target, path);
    expect(() => writeSqliteJson(path, { generationId: "new" })).toThrow();
    expect(fs.lstatSync(path).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(path)).toBe(target);
    expect(fs.readdirSync(root)).toEqual(["active.json"]);
  });
  it("rejects symlink/hard-link aliases and an exact-file replacement", () => {
    const root = fixture(),
      source = join(root, "source.sqlite");
    fs.writeFileSync(source, "owned");
    const identity = sqliteFileIdentity(source);
    fs.renameSync(source, join(root, "old.sqlite"));
    fs.writeFileSync(source, "foreign");
    expect(() => assertSqliteFile(source, identity)).toThrow();
    expect(fs.readFileSync(source, "utf8")).toBe("foreign");
    fs.symlinkSync(source, join(root, "alias.sqlite"));
    fs.linkSync(source, join(root, "hard.sqlite"));
    expect(() => sqliteProjectPath(root, join(root, "alias.sqlite"))).toThrow();
    expect(() => sqliteProjectPath(root, join(root, "hard.sqlite"))).toThrow();
  });
  it("bounds input reads and accepts exactly the authored byte limit", () => {
    const root = fixture(),
      path = join(root, "input");
    fs.writeFileSync(path, "1234");
    expect(readSqliteBytes(path, 4).toString()).toBe("1234");
    fs.appendFileSync(path, "5");
    expect(() => readSqliteBytes(path, 4)).toThrow();
    expect(fs.readFileSync(path, "utf8")).toBe("12345");
  });
  it("does not adopt an existing empty directory", () => {
    const root = fixture(),
      path = join(root, "sqlite");
    fs.mkdirSync(path);
    expect(() => sqliteOwnedDirectory(root, path, config, true)).toThrow();
    expect(fs.readdirSync(path)).toEqual([]);
  });
  it("closes directory handles on malformed owner refusals", () => {
    const root = fixture(),
      path = join(root, "sqlite"),
      owner = sqliteOwnedDirectory(root, path, config, true);
    owner.close();
    fs.writeFileSync(join(path, "owner.json"), "null");
    const fdRoot = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
    const before = fs.readdirSync(fdRoot).length;
    for (let i = 0; i < 20; i++)
      expect(() => sqliteOwnedDirectory(root, path, config)).toThrow();
    expect(fs.readdirSync(fdRoot).length).toBe(before);
  });
  it("retains a replacement directory and refuses its original receipt", () => {
    const root = fixture(),
      path = join(root, "sqlite"),
      owner = sqliteOwnedDirectory(root, path, config, true);
    try {
      fs.renameSync(path, join(root, "retained"));
      fs.mkdirSync(path);
      fs.writeFileSync(join(path, "foreign"), "keep");
      expect(() => owner.assertOwned()).toThrow();
      expect(fs.readFileSync(join(path, "foreign"), "utf8")).toBe("keep");
    } finally {
      owner.close();
    }
  });
  it("canonicalizes a project-root compatibility alias without accepting aliases below it", () => {
    const root = fixture(),
      actual = join(root, "actual"),
      alias = join(root, "compat");
    fs.mkdirSync(actual);
    fs.writeFileSync(join(actual, "source.sqlite"), "safe");
    fs.symlinkSync(actual, alias);
    expect(sqliteProjectPath(alias, join(alias, "source.sqlite"))).toBe(
      join(actual, "source.sqlite"),
    );
    expect(() =>
      sqliteProjectPath(actual, join(actual, "..", "outside"), true),
    ).toThrow();
  });
  it("refuses malformed identities without treating a TypeError as ownership proof", () => {
    expect(sameSqliteIdentity(null, {})).toBe(false);
    expect(
      sameSqliteIdentity(
        { dev: "1", ino: "2", birthtimeNs: "3" },
        { dev: "1", ino: "2", birthtimeNs: "3" },
      ),
    ).toBe(true);
  });
});
