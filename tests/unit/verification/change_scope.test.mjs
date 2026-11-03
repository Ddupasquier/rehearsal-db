import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyChanges,
  isDocumentationPath,
  verificationScope,
} from "../../../scripts/verification/change_scope.mjs";

const base = "1".repeat(40);
const head = "2".repeat(40);
const entry = (status, path, mode = "100644") =>
  `:${status === "A" ? "000000" : "100644"} ${mode} ${status === "A" ? "0".repeat(40) : "a".repeat(40)} ${"b".repeat(40)} ${status}\0${path}\0`;
const environment = {
  REHEARSAL_VERIFY_EVENT: "pull_request",
  REHEARSAL_VERIFY_BASE: base,
  REHEARSAL_VERIFY_HEAD: head,
};
const directories = [];
const temporary = () => {
  const directory = mkdtempSync(join(tmpdir(), "verification-scope-"));
  directories.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("change-focused verification", () => {
  it("selects docs for an entirely public prose change", () => {
    expect(
      classifyChanges(
        entry("M", "README.md") +
          entry("M", "CONTRIBUTING.md") +
          entry("M", "CODE_OF_CONDUCT.md") +
          entry("A", "docs/guides/getting started.md"),
      ),
    ).toMatchObject({ docsOnly: true });
  });

  it.each([
    entry("M", "README.md") + entry("M", "src/cli/rehearsal.mts"),
    entry("M", "docs/site/site.css"),
    entry("M", "scripts/docs/build.mjs"),
    entry("M", "package.json"),
    entry("M", "package-lock.json"),
    entry("M", ".github/workflows/verify.yml"),
    entry("M", "AGENTS.md"),
    entry("M", "notes/private.md"),
    entry("R100", "docs/old.md") + "docs/new.md\0",
    entry("C100", "docs/old.md") + "docs/new.md\0",
    entry("D", "docs/old.md"),
    entry("T", "README.md"),
    entry("X", "README.md"),
    entry("A", "docs/link.md", "120000"),
    entry("A", "docs/tool.md", "100755"),
    entry("A", "docs/submodule.md", "160000"),
    entry("M", "docs/guide.md").slice(0, -1),
    entry("M", "docs/guide.md") + "M\0",
    "",
  ])("uses full checks for mixed, unknown or unsafe inventory %j", (diff) => {
    expect(classifyChanges(diff).docsOnly).toBe(false);
  });

  it.each([
    "/docs/guide.md",
    "docs//guide.md",
    "docs/../src/guide.md",
    "docs\\guide.md",
    "docs/guide\n.md",
    "docs",
    "README.MD",
    ".github/README.md",
    "docs/workspace/checkpoint.md",
    "docs/notes/private.md",
  ])("refuses ambiguous or unowned paths %j", (path) => {
    expect(isDocumentationPath(path)).toBe(false);
  });

  it.each(["pull_request", "push"])("compares exact %s commits", (event) => {
    const readDiff = vi.fn(() => entry("M", "docs/capabilities.md"));
    expect(
      verificationScope(
        { ...environment, REHEARSAL_VERIFY_EVENT: event },
        readDiff,
      ).docsOnly,
    ).toBe(true);
    expect(readDiff).toHaveBeenCalledWith(base, head);
  });

  it.each(["workflow_dispatch", "release", "pull_request_target", undefined])(
    "keeps manual, release and unknown event %j full without reading a diff",
    (event) => {
      const readDiff = vi.fn();
      expect(
        verificationScope(
          { ...environment, REHEARSAL_VERIFY_EVENT: event },
          readDiff,
        ).docsOnly,
      ).toBe(false);
      expect(readDiff).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "", "main", "0".repeat(40), "1".repeat(39), head])(
    "keeps missing, new-branch or uncertain base %j full",
    (comparison) => {
      const readDiff = vi.fn();
      expect(
        verificationScope(
          { ...environment, REHEARSAL_VERIFY_BASE: comparison },
          readDiff,
        ).docsOnly,
      ).toBe(false);
      expect(readDiff).not.toHaveBeenCalled();
    },
  );

  it("falls back to full if Git cannot inspect the complete comparison", () => {
    expect(
      verificationScope(environment, () => {
        throw new Error("comparison unavailable");
      }).docsOnly,
    ).toBe(false);
  });

  it("reports a manual full lane through the actual command output contract", () => {
    const output = join(temporary(), "outputs");
    const stdout = execFileSync(
      process.execPath,
      ["scripts/verification/change_scope.mjs"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ...environment,
          REHEARSAL_VERIFY_EVENT: "workflow_dispatch",
          GITHUB_OUTPUT: output,
        },
      },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      verification: "full",
      docsOnly: false,
    });
    expect(readFileSync(output, "utf8")).toBe("docs_only=false\n");
  });

  it("fails the command if CI cannot persist its routing output", () => {
    const child = spawnSync(
      process.execPath,
      ["scripts/verification/change_scope.mjs"],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          ...environment,
          REHEARSAL_VERIFY_EVENT: "workflow_dispatch",
          GITHUB_OUTPUT: temporary(),
        },
      },
    );
    expect(child.status).not.toBe(0);
    expect(child.stdout).toBe("");
  });
});
