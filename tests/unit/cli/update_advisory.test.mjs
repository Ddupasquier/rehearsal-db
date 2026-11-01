import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  symlink,
  chmod,
  realpath,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  UPDATE_DAY,
  checkCoreUpdate,
  compareUpdateVersions,
  coreUpdateCommand,
  emptyUpdatePreference,
  readUpdatePreference,
  saveUpdatePreference,
} from "../../../dist/src/cli/update_advisory.mjs";
import { createGuidedUpdates } from "../../../dist/src/cli/guided_updates.mjs";
import { notifyStartupUpdate } from "../../../dist/src/cli/startup_updates.mjs";

const roots = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const metadata = (version = "0.1.0-rc.8") => ({
  name: "@rehearsal-db/core",
  version,
  dist: {
    tarball: `https://registry.npmjs.org/@rehearsal-db/core/-/core-${version}.tgz`,
    integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
  },
});
const response = (value = metadata(), options, endpoint) => {
  const result = new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    ...options,
  });
  Object.defineProperty(result, "url", {
    value:
      endpoint ??
      `https://registry.npmjs.org/@rehearsal-db%2Fcore/${typeof value?.version === "string" && !value.version.includes("-") ? "latest" : "beta"}`,
  });
  return result;
};
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "rehearsal-update-advisory-")),
  );
  roots.push(root);
  const project = join(root, "project"),
    directory = join(root, "cache");
  await mkdir(project);
  await registryIdentity(project);
  return { root, project, directory };
}
async function registryIdentity(
  project,
  { manager = "npm", dev = true, specification = "0.1.0-rc.7" } = {},
) {
  const dependency = dev ? "devDependencies" : "dependencies";
  const declaration = { [dependency]: { "@rehearsal-db/core": specification } };
  const entry = {
    version: "0.1.0-rc.7",
    resolved:
      "https://registry.npmjs.org/@rehearsal-db/core/-/core-0.1.0-rc.7.tgz",
    integrity: metadata().dist.integrity,
  };
  await mkdir(join(project, "node_modules/@rehearsal-db/core"), {
    recursive: true,
  });
  await writeFile(
    join(project, "package.json"),
    JSON.stringify({
      name: "independent-consumer",
      packageManager: `${manager}@11.19.0`,
      ...declaration,
    }),
  );
  await writeFile(
    join(project, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: { "": declaration, "node_modules/@rehearsal-db/core": entry },
    }),
  );
  await writeFile(
    join(project, "node_modules/.package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: { "node_modules/@rehearsal-db/core": entry },
    }),
  );
  await writeFile(
    join(project, "node_modules/@rehearsal-db/core/package.json"),
    JSON.stringify({
      name: "@rehearsal-db/core",
      version: entry.version,
      bin: { rehearsal: "dist/src/cli/rehearsal.mjs" },
    }),
  );
}
function harness(input, decisions, extra = {}) {
  const fetchImplementation = vi.fn(async () => response()),
    write = vi.fn();
  const choose = vi.fn(async ({ options }) => {
    const decision = decisions.shift();
    return options.find(({ command }) => command === decision);
  });
  return {
    fetchImplementation,
    write,
    choose,
    run: createGuidedUpdates({
      projectRoot: input.project,
      directory: input.directory,
      installed: "0.1.0-rc.7",
      environment: {},
      terminal: () => true,
      now: () => UPDATE_DAY * 10,
      fetchImplementation,
      choose,
      write,
      ...extra,
    }),
  };
}

describe("explicit core update discovery", () => {
  it("compares numeric/prerelease precedence without treating build or candidate bytes as a new version", () => {
    for (const [a, b, expected] of [
      ["0.1.0-rc.9", "0.1.0-rc.10", -1],
      ["0.1.0-beta.18", "0.1.0-rc.1", -1],
      ["0.1.0-rc.8", "0.1.0", -1],
      ["1.0.0", "0.9.9", 1],
      ["0.1.0-rc.8+candidate", "0.1.0-rc.8", 0],
      ["0.1.0", "0.1.0", 0],
      ["01.0.0", "1.0.0", null],
      ["1.0.0-rc.01", "1.0.0", null],
      ["1.0.0\n", "1.0.0", null],
      ["1.0.0-", "1.0.0", null],
    ])
      expect(compareUpdateVersions(a, b)).toBe(expected);
  });
  it("checks only the fixed appropriate channels without project data, authorization or redirects", async () => {
    const fetchImplementation = vi.fn(async () => response());
    expect(
      await checkCoreUpdate({ installed: "0.1.0-rc.7", fetchImplementation }),
    ).toEqual({
      state: "available",
      version: "0.1.0-rc.8",
      channel: "preview",
    });
    expect(fetchImplementation.mock.calls[0][0]).toBe(
      "https://registry.npmjs.org/@rehearsal-db%2Fcore/beta",
    );
    expect(fetchImplementation.mock.calls.map(([url]) => url)).toEqual([
      "https://registry.npmjs.org/@rehearsal-db%2Fcore/beta",
      "https://registry.npmjs.org/@rehearsal-db%2Fcore/latest",
    ]);
    expect(fetchImplementation.mock.calls[0][1]).toMatchObject({
      redirect: "error",
      credentials: "omit",
      method: "GET",
      headers: { accept: "application/json" },
    });
    for (const [installed, published, state] of [
      ["0.1.0-rc.8", "0.1.0-rc.8", "current"],
      ["0.1.0-rc.9", "0.1.0-rc.8", "ahead"],
      ["0.1.0", "0.1.1", "available"],
    ]) {
      const fetch = vi.fn(async () => response(metadata(published)));
      expect(
        await checkCoreUpdate({ installed, fetchImplementation: fetch }),
      ).toMatchObject({ state, version: published });
      expect(fetch.mock.calls[0][0]).toContain(
        installed === "0.1.0" ? "/latest" : "/beta",
      );
    }
  });
  it("keeps network/schema/channel failures unknown instead of claiming an update", async () => {
    for (const result of [
      response(null),
      response({ ...metadata(), name: "another-package" }),
      response(metadata("invalid")),
      response({
        ...metadata(),
        dist: {
          ...metadata().dist,
          tarball: "https://other.example/package.tgz",
        },
      }),
      response({
        ...metadata(),
        dist: { ...metadata().dist, integrity: "sha512-tiny" },
      }),
      response(metadata(), { status: 404 }),
      response(metadata(), {}, "https://other.example/metadata"),
      response(metadata(), { headers: { "content-type": "text/html" } }),
      response(metadata(), {
        headers: {
          "content-type": "application/json",
          "content-length": "65537",
        },
      }),
      response({ padding: "x".repeat(65537) }),
    ]) {
      expect(
        (
          await checkCoreUpdate({
            installed: "0.1.0-rc.7",
            fetchImplementation: async () => result,
          })
        ).state,
      ).toBe("unavailable");
    }
    expect(
      (
        await checkCoreUpdate({
          installed: "0.1.0",
          fetchImplementation: async () => response(),
        })
      ).state,
    ).toBe("unavailable");
    expect(
      await checkCoreUpdate({
        installed: "0.1.0-rc.7",
        fetchImplementation: async () => response(metadata("0.1.0")),
      }),
    ).toEqual({ state: "available", version: "0.1.0", channel: "stable" });
    expect(
      (
        await checkCoreUpdate({
          installed: "0.1.0-rc.7",
          fetchImplementation: async () => {
            throw Error("SYNTHETIC_PRIVATE_NETWORK_ERROR");
          },
        })
      ).state,
    ).toBe("unavailable");
    const forbidden = vi.fn();
    expect(
      (
        await checkCoreUpdate({
          installed: "not-a-version",
          fetchImplementation: forbidden,
        })
      ).state,
    ).toBe("unavailable");
    expect(forbidden).not.toHaveBeenCalled();
  });
  it("times out even when a transport ignores abort", async () => {
    vi.useFakeTimers();
    const pending = checkCoreUpdate({
      installed: "0.1.0-rc.7",
      timeoutMs: 25,
      fetchImplementation: () => new Promise(() => {}),
    });
    await vi.advanceTimersByTimeAsync(25);
    expect((await pending).state).toBe("unavailable");
  });
  it("discovers stable promotion from a preview and uses one shared deadline for an unavailable channel", async () => {
    for (const [preview, stable, expected] of [
      ["0.1.0-rc.8", "0.1.0", { version: "0.1.0", channel: "stable" }],
      ["0.2.0-rc.1", "0.1.0", { version: "0.2.0-rc.1", channel: "preview" }],
    ]) {
      expect(
        await checkCoreUpdate({
          installed: "0.1.0-rc.7",
          fetchImplementation: async (url) =>
            response(
              metadata(String(url).endsWith("/beta") ? preview : stable),
            ),
        }),
      ).toEqual({ state: "available", ...expected });
    }
    vi.useFakeTimers();
    const pending = checkCoreUpdate({
      installed: "0.1.0-rc.7",
      timeoutMs: 25,
      fetchImplementation: (url) =>
        String(url).endsWith("/beta")
          ? new Promise(() => {})
          : Promise.resolve(response(metadata("0.1.0"))),
    });
    await vi.advanceTimersByTimeAsync(25);
    expect(await pending).toEqual({
      state: "available",
      version: "0.1.0",
      channel: "stable",
    });
  });
});

describe("interactive consent and bounded reminders", () => {
  it("shows the update command immediately even when the guide user chooses Later", async () => {
    const input = await fixture();
    const subject = harness(input, ["once", "later"]);
    expect(await subject.run({})).toBe(false);
    expect(subject.write.mock.calls.flat().join("\n")).toContain(
      "After exiting this guide, update with: npm install --save-dev --save-exact @rehearsal-db/core@0.1.0-rc.8",
    );
  });
  it("offers consent by default, makes no request on Not now, and does not repeat across home screens or the same day", async () => {
    const input = await fixture(),
      first = harness(input, ["later"]);
    expect(await first.run({})).toBe(false);
    expect(first.choose).toHaveBeenCalledTimes(1);
    expect(first.fetchImplementation).not.toHaveBeenCalled();
    await first.run({});
    expect(first.choose).toHaveBeenCalledTimes(1);
    const second = harness(input, []);
    await second.run({});
    expect(second.choose).not.toHaveBeenCalled();
    expect(
      (await readUpdatePreference(input.directory, UPDATE_DAY * 10)).permission,
    ).toBe("ask");
  });
  it("checks automatically on a later opening only after consent and once per day", async () => {
    const input = await fixture(),
      first = harness(input, ["enable", "later"]);
    await first.run({});
    expect(first.fetchImplementation).toHaveBeenCalledTimes(2);
    const sameDay = harness(input, []);
    await sameDay.run({});
    expect(sameDay.fetchImplementation).not.toHaveBeenCalled();
    const tomorrow = harness(input, ["later"], { now: () => UPDATE_DAY * 11 });
    await tomorrow.run({});
    expect(tomorrow.fetchImplementation).toHaveBeenCalledTimes(2);
    expect(tomorrow.choose.mock.calls[0][0].message).toContain(
      "Core update available",
    );
  });
  it("skips one release, allows explicit checks, and honours disabled reminders", async () => {
    const input = await fixture();
    await harness(input, ["enable", "skip"]).run({});
    const later = harness(input, [], { now: () => UPDATE_DAY * 11 });
    await later.run({});
    expect(later.choose).not.toHaveBeenCalled();
    const manual = harness(input, ["once", "disable"], {
      now: () => UPDATE_DAY * 11,
    });
    await manual.run({}, true);
    const disabled = harness(input, [], { now: () => UPDATE_DAY * 12 });
    await disabled.run({});
    expect(disabled.choose).not.toHaveBeenCalled();
    expect(disabled.fetchImplementation).not.toHaveBeenCalled();
  });
  it("prints an exact command and exits without installing or changing reviewed project files", async () => {
    const input = await fixture(),
      before = await readFile(join(input.project, "package.json"), "utf8");
    const subject = harness(input, ["once", "update"]);
    expect(await subject.run({})).toBe(true);
    expect(subject.write.mock.calls.flat().join("\n")).toContain(
      "npm install --save-dev --save-exact @rehearsal-db/core@0.1.0-rc.8",
    );
    expect(await readFile(join(input.project, "package.json"), "utf8")).toBe(
      before,
    );
  });
  it("is entirely silent and cache/network-free for JSON, CI, nonterminal or explicit opt-out", async () => {
    for (const [flags, extra] of [
      [{ json: true }, {}],
      [{}, { environment: { CI: "1" } }],
      [{}, { environment: { CODEX_CI: "1" } }],
      [{}, { terminal: () => false }],
      [{}, { environment: { REHEARSAL_UPDATE_CHECK: "off" } }],
    ]) {
      const input = await fixture(),
        subject = harness(input, [], extra);
      await subject.run(flags);
      expect(subject.choose).not.toHaveBeenCalled();
      expect(subject.write).not.toHaveBeenCalled();
      expect(subject.fetchImplementation).not.toHaveBeenCalled();
      await expect(
        readFile(join(input.directory, "updates-v1.json")),
      ).rejects.toThrow();
    }
  });
  it("keeps even explicit machine checks silent, handles cancellation, and isolates a task-specific state directory", async () => {
    for (const extra of [
      { environment: { CI: "1" } },
      { terminal: () => false },
      {},
    ]) {
      const input = await fixture(),
        subject = harness(input, [], extra);
      await subject.run({ json: true }, true);
      expect(subject.write).not.toHaveBeenCalled();
      expect(subject.choose).not.toHaveBeenCalled();
      expect(subject.fetchImplementation).not.toHaveBeenCalled();
    }
    const input = await fixture(),
      cancelled = harness(input, []);
    expect(await cancelled.run({})).toBe(true);
    expect(cancelled.fetchImplementation).not.toHaveBeenCalled();
    const isolated = harness(input, ["later"], {
      directory: undefined,
      environment: { REHEARSAL_UPDATE_STATE_DIR: input.directory },
    });
    await isolated.run({});
    expect(
      JSON.parse(
        await readFile(join(input.directory, "updates-v1.json"), "utf8"),
      ).lastPromptAt,
    ).toBe(UPDATE_DAY * 10);
    const invalid = harness(input, [], {
      directory: undefined,
      environment: { REHEARSAL_UPDATE_STATE_DIR: "relative-cache" },
    });
    await invalid.run({});
    await invalid.run({});
    expect(invalid.fetchImplementation).not.toHaveBeenCalled();
    expect(invalid.write).toHaveBeenCalledTimes(1);
  });
  it("exits cleanly for the observed plain Ctrl+C rejection without swallowing unrelated prompt faults", async () => {
    const cancellation = Object.assign(new Error("Aborted with Ctrl+C"), {
      name: "AbortError",
      code: "ABORT_ERR",
    });
    for (const phase of ["consent", "notification"]) {
      const input = await fixture();
      let called = 0;
      const subject = harness(input, [], {
        choose: async ({ options }) => {
          if (phase === "notification" && called++ === 0)
            return options.find(({ command }) => command === "once");
          throw cancellation;
        },
      });
      expect(await subject.run({ plain: true })).toBe(true);
      expect(subject.fetchImplementation).toHaveBeenCalledTimes(
        phase === "consent" ? 0 : 2,
      );
    }
    for (const error of [
      new Error("Unexpected prompt fault"),
      Object.assign(new Error("Different abort cause"), {
        name: "AbortError",
        code: "ABORT_ERR",
      }),
    ]) {
      const subject = harness(await fixture(), [], {
        choose: async () => {
          throw error;
        },
      });
      await expect(subject.run({ plain: true })).rejects.toBe(error);
      expect(subject.fetchImplementation).not.toHaveBeenCalled();
    }
  });
  it("treats offline results as unavailable and leaves existing local use unblocked", async () => {
    const input = await fixture(),
      subject = harness(input, ["once"], {
        fetchImplementation: async () => {
          throw Error("PRIVATE_NETWORK_CANARY");
        },
      });
    expect(await subject.run({})).toBe(false);
    expect(subject.write.mock.calls.flat().join("\n")).toContain(
      "Update information is unavailable",
    );
    expect(subject.write.mock.calls.flat().join("\n")).not.toContain(
      "PRIVATE_NETWORK_CANARY",
    );
  });
});

describe("private preferences and custom installations", () => {
  it("stores only bounded public settings and refuses unsafe or malformed cache files", async () => {
    const input = await fixture(),
      value = {
        ...emptyUpdatePreference(),
        permission: "enabled",
        lastCheckAt: UPDATE_DAY,
      };
    expect(await saveUpdatePreference(input.directory, value)).toBe(true);
    expect(await readUpdatePreference(input.directory, UPDATE_DAY * 2)).toEqual(
      value,
    );
    const file = join(input.directory, "updates-v1.json");
    for (const content of [
      "null",
      JSON.stringify({ ...value, lastCheckAt: UPDATE_DAY * 3 }),
      JSON.stringify({ ...value, credential: "DO_NOT_RETAIN" }),
      "x".repeat(8193),
    ]) {
      await writeFile(file, content);
      expect(
        await readUpdatePreference(input.directory, UPDATE_DAY * 2),
      ).toEqual(emptyUpdatePreference());
    }
    await rm(file);
    const target = join(input.root, "unrelated.json");
    await writeFile(target, "unrelated");
    await symlink(target, file);
    expect(await saveUpdatePreference(input.directory, value)).toBe(false);
    expect(await readFile(target, "utf8")).toBe("unrelated");
    await rm(file);
    await writeFile(file, JSON.stringify(value));
    await chmod(file, 0o644);
    expect(await readUpdatePreference(input.directory, UPDATE_DAY * 2)).toEqual(
      emptyUpdatePreference(),
    );
  });
  it("refuses candidate/custom origins, mismatched exact versions and unsupported managers", async () => {
    const input = await fixture();
    for (const specification of [
      "file:/tmp/candidate.tgz",
      "git+https://example.test/repository",
      "workspace:*",
      "0.1.0-rc.6",
      "^1.0.0",
    ]) {
      await writeFile(
        join(input.project, "package.json"),
        JSON.stringify({
          devDependencies: { "@rehearsal-db/core": specification },
        }),
      );
      expect(
        await coreUpdateCommand(input.project, "0.1.0-rc.7", "0.1.0-rc.8"),
      ).toBeNull();
    }
    for (const manager of ["npm", "pnpm", "yarn", "bun"]) {
      await registryIdentity(input.project, {
        manager,
        dev: false,
        specification: "^0.1.0-rc.4",
      });
      const command = await coreUpdateCommand(
        input.project,
        "0.1.0-rc.7",
        "0.1.0-rc.8",
      );
      if (manager === "npm") {
        expect(command).toContain("@rehearsal-db/core@0.1.0-rc.8");
        expect(command).not.toContain("@latest");
        expect(command).not.toContain("--dev");
      } else expect(command).toBeNull();
    }
    expect(
      await coreUpdateCommand(input.project, "0.1.0-rc.8", "0.1.0-rc.8"),
    ).toBeNull();
    expect(
      await coreUpdateCommand(input.project, "0.1.0-rc.9", "0.1.0-rc.8"),
    ).toBeNull();
  });
  it("refuses unrecorded installed candidates, changed origin/integrity and new compatibility series", async () => {
    const input = await fixture();
    for (const change of [
      { version: "0.1.0-rc.8" },
      { resolved: "file:/synthetic/candidate.tgz" },
      { integrity: "sha512-invalid" },
    ]) {
      await registryIdentity(input.project);
      const file = join(input.project, "node_modules/.package-lock.json"),
        lock = JSON.parse(await readFile(file, "utf8"));
      Object.assign(lock.packages["node_modules/@rehearsal-db/core"], change);
      await writeFile(file, JSON.stringify(lock));
      expect(
        await coreUpdateCommand(input.project, "0.1.0-rc.7", "0.1.0-rc.8"),
      ).toBeNull();
    }
    await registryIdentity(input.project);
    for (const version of ["0.2.0", "1.0.0"])
      expect(
        await coreUpdateCommand(input.project, "0.1.0-rc.7", version),
      ).toBeNull();
  });
  it("refuses symlink ancestors without creating state and preserves a concurrent Disable decision", async () => {
    const input = await fixture(),
      target = join(input.root, "actual-cache"),
      link = join(input.root, "linked-cache");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, link);
    expect(
      await saveUpdatePreference(
        join(link, "new-leaf"),
        emptyUpdatePreference(),
      ),
    ).toBe(false);
    await expect(
      readFile(join(target, "new-leaf/updates-v1.json")),
    ).rejects.toThrow();
    const original = { ...emptyUpdatePreference(), permission: "enabled" };
    expect(await saveUpdatePreference(input.directory, original)).toBe(true);
    const stale = await readUpdatePreference(input.directory, UPDATE_DAY * 10);
    const disabled = { ...original, permission: "disabled" };
    expect(
      await saveUpdatePreference(input.directory, disabled, original),
    ).toBe(true);
    expect(
      await saveUpdatePreference(
        input.directory,
        { ...stale, lastCheckAt: UPDATE_DAY },
        stale,
      ),
    ).toBe(false);
    expect(
      (await readUpdatePreference(input.directory, UPDATE_DAY * 10)).permission,
    ).toBe("disabled");
  });
  it("keeps ambiguous dependency groups, manager declarations and competing locks manual-only", async () => {
    const input = await fixture();
    for (const change of [
      { optionalDependencies: { "@rehearsal-db/core": "0.1.0-rc.7" } },
      { packageManager: 12 },
      { packageManager: "npm@unknown" },
      { packageManager: "npm@11.19.0\n" },
    ]) {
      await registryIdentity(input.project);
      const path = join(input.project, "package.json");
      const manifest = JSON.parse(await readFile(path, "utf8"));
      await writeFile(path, JSON.stringify({ ...manifest, ...change }));
      expect(
        await coreUpdateCommand(input.project, "0.1.0-rc.7", "0.1.0-rc.8"),
      ).toBeNull();
    }
    for (const name of [
      "npm-shrinkwrap.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "bun.lock",
      "bun.lockb",
    ]) {
      await registryIdentity(input.project);
      const path = join(input.project, name);
      await writeFile(path, "");
      expect(
        await coreUpdateCommand(input.project, "0.1.0-rc.7", "0.1.0-rc.8"),
      ).toBeNull();
      await rm(path);
    }
  });
  it("serializes simultaneous saves and never overwrites a successfully committed Disable choice", async () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const input = await fixture();
      const original = { ...emptyUpdatePreference(), permission: "enabled" };
      expect(await saveUpdatePreference(input.directory, original)).toBe(true);
      const disabled = { ...original, permission: "disabled" };
      const stale = { ...original, lastCheckAt: UPDATE_DAY };
      const results = await Promise.all([
        saveUpdatePreference(input.directory, disabled, original),
        saveUpdatePreference(input.directory, stale, original),
      ]);
      expect(results.filter(Boolean)).toHaveLength(1);
      expect(
        await readUpdatePreference(input.directory, UPDATE_DAY * 10),
      ).toEqual(results[0] ? disabled : stale);
      expect(await readdir(input.directory)).toEqual(["updates-v1.json"]);
      if (results[0]) {
        expect(
          await saveUpdatePreference(input.directory, stale, original),
        ).toBe(false);
        expect(
          (await readUpdatePreference(input.directory, UPDATE_DAY * 10))
            .permission,
        ).toBe("disabled");
      }
    }
  });
  it("refuses existing locks without stealing, following or deleting them", async () => {
    const input = await fixture();
    await mkdir(input.directory, { mode: 0o700 });
    const path = join(input.directory, "updates-v1.lock");
    await writeFile(path, "retained-lock", { mode: 0o600 });
    expect(
      await saveUpdatePreference(input.directory, emptyUpdatePreference()),
    ).toBe(false);
    expect(await readFile(path, "utf8")).toBe("retained-lock");
    await rm(path);
    const target = join(input.root, "untouched");
    await writeFile(target, "private-target", { mode: 0o600 });
    await symlink(target, path);
    expect(
      await saveUpdatePreference(input.directory, emptyUpdatePreference()),
    ).toBe(false);
    expect(await readFile(target, "utf8")).toBe("private-target");
    expect(await readdir(input.directory)).toEqual(["updates-v1.lock"]);
  });
});

describe("terminal startup update notice", () => {
  async function startup(input, extra = {}) {
    const fetchImplementation = vi.fn(async () => response());
    const write = vi.fn();
    await notifyStartupUpdate({
      projectRoot: input.project,
      flags: {},
      command: "doctor",
      guided: false,
      installed: "0.1.0-rc.7",
      terminal: true,
      environment: { REHEARSAL_UPDATE_STATE_DIR: input.directory },
      fetchImplementation,
      write,
      ...extra,
    });
    return { fetchImplementation, write };
  }
  it("prints the exact npm command without modifying the project or creating a cache", async () => {
    const input = await fixture();
    const before = await readFile(join(input.project, "package.json"), "utf8");
    const subject = await startup(input);
    expect(subject.write).toHaveBeenCalledExactlyOnceWith(
      "Rehearsal update available: 0.1.0-rc.7 → 0.1.0-rc.8.\nAfter this command finishes, update with: npm install --save-dev --save-exact @rehearsal-db/core@0.1.0-rc.8",
    );
    expect(await readFile(join(input.project, "package.json"), "utf8")).toBe(
      before,
    );
    await expect(readdir(input.directory)).rejects.toThrow();
  });
  it("never checks machine output, help, version, shutdown, the guide or opted-out sessions", async () => {
    for (const extra of [
      { flags: { json: true } },
      { flags: { help: true } },
      { flags: { version: true } },
      { command: "version" },
      { command: "help" },
      { command: "engine stop" },
      { command: "stop" },
      { command: "stop-stale" },
      { guided: true },
      { terminal: false },
      { environment: { CI: "1" } },
      { environment: { CODEX_CI: "1" } },
      { environment: { REHEARSAL_UPDATE_CHECK: "off" } },
      { environment: { REHEARSAL_UPDATE_STATE_DIR: "relative" } },
    ]) {
      const subject = await startup(await fixture(), extra);
      expect(subject.fetchImplementation).not.toHaveBeenCalled();
      expect(subject.write).not.toHaveBeenCalled();
    }
  });
  it("honours disabled checks and skipped releases without rewriting preferences", async () => {
    for (const patch of [
      { permission: "disabled" },
      { skippedVersion: "0.1.0-rc.8" },
    ]) {
      const input = await fixture();
      await saveUpdatePreference(input.directory, {
        ...emptyUpdatePreference(),
        ...patch,
      });
      const before = await readFile(
        join(input.directory, "updates-v1.json"),
        "utf8",
      );
      const subject = await startup(input);
      expect(subject.write).not.toHaveBeenCalled();
      if (patch.permission)
        expect(subject.fetchImplementation).not.toHaveBeenCalled();
      expect(
        await readFile(join(input.directory, "updates-v1.json"), "utf8"),
      ).toBe(before);
    }
  });
  it("does not claim an update when current, ahead, offline or metadata is invalid", async () => {
    for (const fetchImplementation of [
      async () => response(metadata("0.1.0-rc.7")),
      async () => response(metadata("0.1.0-rc.6")),
      async () => {
        throw new Error("offline");
      },
      async () => response({ ...metadata(), name: "other" }),
    ]) {
      const subject = await startup(await fixture(), { fetchImplementation });
      expect(subject.write).not.toHaveBeenCalled();
    }
  });
  it("bounds an unresponsive registry to 750ms and aborts the request", async () => {
    vi.useFakeTimers();
    const input = await fixture();
    const signals = [];
    const pending = startup(input, {
      fetchImplementation: async (_url, options) => {
        signals.push(options.signal);
        return new Promise(() => {});
      },
    });
    // Preference reads use real filesystem I/O before the network timer is armed.
    await vi.waitFor(() => expect(signals.length).toBe(2));
    await vi.advanceTimersByTimeAsync(750);
    const subject = await pending;
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(subject.write).not.toHaveBeenCalled();
  });
  it("keeps unverified origins and breaking upgrades manual instead of inventing an install command", async () => {
    const input = await fixture();
    await writeFile(join(input.project, "package.json"), "{}");
    const subject = await startup(input);
    expect(subject.write.mock.calls[0][0]).toContain(
      "Review compatibility and installation instructions:",
    );
    expect(subject.write.mock.calls[0][0]).not.toContain("npm install");
  });
});
