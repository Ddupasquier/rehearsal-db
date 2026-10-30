import { configureKnexApplication } from "../../../dist/src/targets/knex_application_configuration.mjs";
import { performance } from "node:perf_hooks";
import { mkdtemp, rm, readFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import {
  withKnexRestrictedRole,
  currentKnexSqlRemainingMs,
  currentKnexSqlSignal,
  currentKnexSqlCredentials,
} from "../../../dist/src/targets/knex_restricted_role.mjs";
import { EventEmitter } from "node:events";
import {
  runWithOperationCancellation,
  throwIfOperationCancelled,
} from "../../../dist/src/shared/cancellation.mjs";
const roots = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "knex-role-"));
  roots.push(root);
  await chmod(root, 0o700);
  const state = {
    authentications: 0,
    sessions: 0,
    terminations: 0,
    createdOid: 20000,
    oid: null,
    parameter: false,
    systemIdentifier: "1234567890123456789",
    databaseOid: 5,
    login: false,
    password: false,
    secret: null,
    mutations: [],
    unsafe: false,
    schemaCreate: false,
    activateFailure: false,
  };
  const options = {
    projectId: "safe-project",
    generationId: "synthetic-generation-1",
    authenticateApplication: (credentials) => {
      state.authentications++;
      if (!state.login || state.secret !== credentials.password)
        throw Error("Authentication refused");
    },
    database: "postgres",
    runtimeWorkdir: root,
    assertOwnedTarget: () => "a".repeat(64),
    runSql: (qualifiedQuery) => {
      const query = qualifiedQuery.replaceAll("pg_catalog.", "");
      if (query.includes("json_build_object('systemIdentifier'"))
        return JSON.stringify({
          systemIdentifier: state.systemIdentifier,
          databaseOid: state.databaseOid,
          roleOid: state.oid,
        });
      if (query.includes("json_build_object('roles'"))
        return JSON.stringify({
          roles: 1,
          memberships: 0,
          definers: 0,
          extensions: 0,
          foreignServers: 0,
          foreignWrappers: 0,
          unsafeFunctions: 0,
          databaseCreate: state.unsafe,
          schemaCreate: state.schemaCreate,
        });
      if (query.startsWith("select has_parameter_privilege"))
        return state.parameter ? "t" : "f";
      if (query.startsWith("grant set on parameter")) {
        state.parameter = true;
        return "";
      }
      if (query.startsWith("revoke set on parameter")) {
        state.parameter = false;
        return "";
      }
      if (query.startsWith("grant select")) return "";
      if (query.startsWith("select count(*)::text from pg_authid"))
        return !state.login && !state.password && state.sessions === 0
          ? "1"
          : "0";
      if (query.startsWith("select count(*)::text from pg_stat_activity"))
        return String(state.sessions);
      state.mutations.push(query.split(" ")[0]);
      if (query.startsWith("create role")) {
        state.oid = state.createdOid;
        return "";
      }
      if (query.includes(" nologin password null")) {
        if (query.includes("pg_terminate_backend")) {
          state.sessions = 0;
          state.terminations++;
        }
        state.login = state.password = false;
        return "";
      }
      if (query.includes(" login password")) {
        state.secret =
          query.match(/login password '([a-f0-9]{64})'/)?.[1] ?? null;
        state.login = state.password = true;
        if (state.activateFailure) throw Error("PRIVATE_PASSWORD_CANARY");
        return "";
      }
      if (query.startsWith("grant connect")) return "";
      throw Error("Unexpected fake SQL");
    },
  };
  return { root, state, options };
};
it("creates private OID/cluster receipt, rotates only owned restricted credential and disables it after work", async () => {
  const f = await fixture();
  let calls = 0;
  const work = async (c) => {
    calls++;
    expect(c.user).toMatch(/^rehearsal_knex_[a-f0-9]{16}$/);
    expect(c.password).toMatch(/^[a-f0-9]{64}$/);
    expect(f.state.login).toBe(true);
    return "done";
  };
  expect(await withKnexRestrictedRole({ ...f.options, work })).toBe("done");
  expect(f.state.login).toBe(false);
  expect(f.state.password).toBe(false);
  const receipt = JSON.parse(
    await readFile(join(f.root, "knex-role.json"), "utf8"),
  );
  expect(receipt.roleOid).toBe(20000);
  expect(Object.keys(receipt)).not.toContain("password");
  expect(
    await withKnexRestrictedRole({
      ...f.options,
      assertOwnedTarget: () => "b".repeat(64),
      work,
    }),
  ).toBe("done");
  expect(calls).toBe(2);
  expect(f.state.mutations).not.toContain("revoke");
});
it("refuses unknown same-name role before any grants/password/session mutations", async () => {
  const f = await fixture();
  f.state.oid = 9000;
  await expect(
    withKnexRestrictedRole({
      ...f.options,
      work: () => {
        throw Error("MUST_NOT_RUN");
      },
    }),
  ).rejects.toThrow(/unsafe/);
  expect(f.state.mutations).toEqual([]);
});
it("refuses changed database cluster and preserves the known role", async () => {
  const f = await fixture();
  await withKnexRestrictedRole({ ...f.options, work: async () => {} });
  f.state.systemIdentifier = "999999";
  f.state.mutations = [];
  await expect(
    withKnexRestrictedRole({
      ...f.options,
      work: async () => {
        throw Error("MUST_NOT_RUN");
      },
    }),
  ).rejects.toThrow();
  expect(f.state.mutations).toEqual([]);
});
it("refuses unsafe PUBLIC effective privileges without changing PUBLIC ACLs", async () => {
  const f = await fixture();
  f.state.unsafe = true;
  await expect(
    withKnexRestrictedRole({
      ...f.options,
      work: async () => {
        throw Error("MUST_NOT_RUN");
      },
    }),
  ).rejects.toThrow();
  expect(f.state.login).toBe(false);
  expect(f.state.mutations).not.toContain("revoke");
  expect(f.state.mutations).not.toContain("grant");
});
it("cleans partial credential activation and never exposes raw SQL failure text", async () => {
  const f = await fixture();
  f.state.activateFailure = true;
  let error;
  try {
    await withKnexRestrictedRole({
      ...f.options,
      work: async () => {
        throw Error("MUST_NOT_RUN");
      },
    });
  } catch (e) {
    error = e;
  }
  expect(error).toBeTruthy();
  expect(String(error)).not.toContain("PRIVATE_PASSWORD_CANARY");
  expect(JSON.stringify(error)).not.toContain("PRIVATE_PASSWORD_CANARY");
  expect(f.state.login).toBe(false);
  expect(f.state.password).toBe(false);
});
it("refuses nonprivate receipts and active owned role without password/session changes", async () => {
  const f = await fixture();
  await withKnexRestrictedRole({ ...f.options, work: async () => {} });
  await chmod(join(f.root, "knex-role.json"), 0o644);
  f.state.mutations = [];
  await expect(
    withKnexRestrictedRole({ ...f.options, work: async () => {} }),
  ).rejects.toThrow();
  expect(f.state.mutations).toEqual([]);
  await chmod(join(f.root, "knex-role.json"), 0o600);
  f.state.login = true;
  await expect(
    withKnexRestrictedRole({ ...f.options, work: async () => {} }),
  ).rejects.toThrow();
  expect(f.state.mutations).toEqual([]);
});
it("cancellation shields only owned credential/backend cleanup instead of leaving the role active", async () => {
  const f = await fixture(),
    signals = new EventEmitter(),
    original = f.options.runSql;
  await expect(
    runWithOperationCancellation({
      signalTarget: signals,
      input: null,
      task: async () =>
        withKnexRestrictedRole({
          ...f.options,
          runSql: (sql) => {
            throwIfOperationCancelled();
            return original(sql);
          },
          work: async () => {
            signals.emit("SIGINT");
            throwIfOperationCancelled();
          },
        }),
    }),
  ).rejects.toThrow();
  expect(f.state.login).toBe(false);
  expect(f.state.password).toBe(false);
});

it("binds restore separately, limits parameter permission to work, then revokes and disables login", async () => {
  const f = await fixture();
  let user;
  await withKnexRestrictedRole({
    ...f.options,
    phase: "restore",
    work: async (credentials) => {
      user = credentials.user;
      expect(user).toMatch(/_restore$/);
      expect(f.state.parameter).toBe(true);
    },
  });
  expect(f.state.parameter).toBe(false);
  expect(f.state.login).toBe(false);
  const receipt = JSON.parse(
    await readFile(join(f.root, "knex-restore-role.json"), "utf8"),
  );
  expect(receipt.role).toBe(user);
  await expect(
    readFile(join(f.root, "knex-role.json"), "utf8"),
  ).rejects.toThrow();
});
it("revokes restore permission even when restricted work fails", async () => {
  const f = await fixture();
  await expect(
    withKnexRestrictedRole({
      ...f.options,
      phase: "restore",
      work: async () => {
        throw Error("untrusted failure");
      },
    }),
  ).rejects.toThrow();
  expect(f.state.parameter).toBe(false);
  expect(f.state.login).toBe(false);
});
it("retains only a successful application login, without restore permission or administrative identity", async () => {
  const f = await fixture();
  await withKnexRestrictedRole({
    ...f.options,
    phase: "application",
    work: async (c) => {
      expect(c.user).toMatch(/_application$/);
      expect(f.state.parameter).toBe(false);
    },
  });
  expect(f.state.login).toBe(true);
  expect(f.state.parameter).toBe(false);
});

it("verification credentials cannot acquire restore permission or DML grants", async () => {
  const f = await fixture();
  const queries = [];
  const runSql = f.options.runSql;
  await withKnexRestrictedRole({
    ...f.options,
    phase: "verify",
    runSql: (sql) => {
      queries.push(sql);
      return runSql(sql);
    },
    work: async (c) => {
      expect(c.user).toMatch(/_verify$/);
    },
  });
  expect(queries.some((sql) => sql.startsWith("grant set"))).toBe(false);
  expect(
    queries.some((sql) => sql.startsWith("grant select on all tables")),
  ).toBe(true);
  expect(
    queries.some((sql) => sql.includes("grant select on all sequences")),
  ).toBe(true);
  expect(f.state.login).toBe(false);
});
it("an unsuccessful application activation revokes its credential instead of retaining login", async () => {
  const f = await fixture();
  await expect(
    withKnexRestrictedRole({
      ...f.options,
      phase: "application",
      work: async () => {
        throw Error("failure");
      },
    }),
  ).rejects.toThrow();
  expect(f.state.login).toBe(false);
});
it("unknown phase names are refused before target or administrator work", async () => {
  const f = await fixture();
  await expect(
    withKnexRestrictedRole({
      ...f.options,
      phase: "../../foreign",
      work: async () => {
        throw Error("must not run");
      },
    }),
  ).rejects.toThrow();
  expect(f.state.mutations).toEqual([]);
});

it("reuses and authenticates the exact application password across repeated start/verify phases without rotation", async () => {
  const f = await fixture();
  const seen = [];
  const work = async (c) => seen.push({ ...c });
  await withKnexRestrictedRole({ ...f.options, phase: "application", work });
  const first = await readFile(
    join(f.root, "knex-application-credential.json"),
    "utf8",
  );
  f.state.mutations = [];
  await withKnexRestrictedRole({ ...f.options, phase: "application", work });
  expect(seen[1]).toEqual(seen[0]);
  expect(f.state.authentications).toBe(2);
  expect(f.state.mutations).not.toContain("set");
  expect(
    await readFile(join(f.root, "knex-application-credential.json"), "utf8"),
  ).toBe(first);
  expect(f.state.login).toBe(true);
});
it("refuses generation drift or failed authentication without rotating or disabling a live application credential", async () => {
  const f = await fixture();
  await withKnexRestrictedRole({
    ...f.options,
    phase: "application",
    work: async () => {},
  });
  const secret = f.state.secret;
  const rejectedWork = vi.fn(async () => undefined);
  f.state.mutations = [];
  await expect(
    withKnexRestrictedRole({
      ...f.options,
      phase: "application",
      generationId: "different-generation",
      work: async () => {},
    }),
  ).rejects.toThrow();
  expect(f.state.mutations).toEqual([]);
  await expect(
    withKnexRestrictedRole({
      ...f.options,
      phase: "application",
      authenticateApplication: () => {
        throw Error("refused");
      },
      work: rejectedWork,
    }),
  ).rejects.toThrow();
  expect(rejectedWork).not.toHaveBeenCalled();
  expect(f.state.login).toBe(true);
  expect(f.state.secret).toBe(secret);
  expect(f.state.mutations).not.toContain("set");
});

it("does not repair a forged stored application password or revoke the still-live original", async () => {
  const f = await fixture();
  await withKnexRestrictedRole({
    ...f.options,
    phase: "application",
    work: async () => {},
  });
  const path = join(f.root, "knex-application-credential.json"),
    original = JSON.parse(await readFile(path, "utf8")),
    forged = { ...original, password: "e".repeat(64) };
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path, JSON.stringify(forged));
  f.state.mutations = [];
  const rejectedWork = vi.fn(async () => undefined);
  await expect(
    withKnexRestrictedRole({
      ...f.options,
      phase: "application",
      work: rejectedWork,
    }),
  ).rejects.toThrow();
  expect(rejectedWork).not.toHaveBeenCalled();
  expect(f.state.secret).toBe(original.password);
  expect(f.state.login).toBe(true);
  expect(f.state.mutations).not.toContain("set");
  expect(await readFile(path, "utf8")).toBe(JSON.stringify(forged));
});

it("inherits the earlier monotonic parent deadline for nested phases", async () => {
  const outer = await fixture(),
    inner = await fixture();
  let now = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  await withKnexRestrictedRole({
    ...outer.options,
    work: async () => {
      expect(currentKnexSqlRemainingMs()).toBe(120000);
      now = 119000;
      await withKnexRestrictedRole({
        ...inner.options,
        phase: "verify",
        work: async () => {
          expect(currentKnexSqlRemainingMs()).toBe(2000);
          expect(currentKnexSqlSignal().aborted).toBe(false);
        },
      });
    },
  });
});
it("refuses expired work synchronously even when the abort timer has not fired, while still cleaning up", async () => {
  const f = await fixture();
  let now = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  await expect(
    withKnexRestrictedRole({
      ...f.options,
      work: async () => {
        now = 121001;
        expect(currentKnexSqlSignal().aborted).toBe(false);
        expect(() => currentKnexSqlCredentials()).toThrow(/deadline expired/);
      },
    }),
  ).rejects.toThrow(/deadline expired/);
  expect(f.state.login).toBe(false);
  expect(f.state.password).toBe(false);
});

it("captures the persistent application environment before entering an ephemeral configuration query role", async () => {
  const app = await fixture(),
    query = await fixture();
  query.state.createdOid = 20001;
  let published;
  await withKnexRestrictedRole({
    ...app.options,
    phase: "application",
    work: async () => {
      const captured = currentKnexSqlCredentials();
      const environment = await configureKnexApplication({
        captureEnvironment: () => ({
          user: captured.user,
          password: captured.password,
          databaseUrl: `postgresql://${captured.user}@127.0.0.1/owned`,
        }),
        withQueryPhase: (work) =>
          withKnexRestrictedRole({
            ...query.options,
            phase: "application_query",
            work,
          }),
        configure: (env) => {
          expect(Object.isFrozen(env)).toBe(true);
          expect(env.user).toBe(captured.user);
          expect(currentKnexSqlCredentials().user).toMatch(
            /_application_query$/,
          );
          expect(currentKnexSqlCredentials().user).not.toBe(env.user);
          query.state.sessions = 1;
          return { value: "configured" };
        },
        publish: async (env, result) => {
          expect(currentKnexSqlCredentials().user).toBe(captured.user);
          expect(query.state.login).toBe(false);
          published = { env, result };
        },
      });
      expect(environment.user).toBe(captured.user);
      expect(published.env).toBe(environment);
    },
  });
  expect(query.state.sessions).toBe(0);
  expect(query.state.terminations).toBeGreaterThan(0);
  expect(app.state.login).toBe(true);
});
it("tears down failed Core application queries without rotating credentials or terminating prior application sessions", async () => {
  const app = await fixture(),
    query = await fixture();
  query.state.createdOid = 20001;
  await withKnexRestrictedRole({
    ...app.options,
    phase: "application",
    work: async () => {},
  });
  app.state.sessions = 2;
  const secret = app.state.secret,
    credential = await readFile(
      join(app.root, "knex-application-credential.json"),
      "utf8",
    ),
    publish = vi.fn();
  await expect(
    withKnexRestrictedRole({
      ...app.options,
      phase: "application",
      work: async () =>
        configureKnexApplication({
          captureEnvironment: () => ({ ...currentKnexSqlCredentials() }),
          withQueryPhase: (work) =>
            withKnexRestrictedRole({
              ...query.options,
              phase: "application_query",
              work,
            }),
          configure: (env) => {
            expect(env.user).toMatch(/_application$/);
            expect(currentKnexSqlCredentials().user).toMatch(
              /_application_query$/,
            );
            query.state.sessions = 1;
            throw Error("simulated query timeout");
          },
          publish,
        }),
    }),
  ).rejects.toThrow(/simulated query timeout/);
  expect(publish).not.toHaveBeenCalled();
  expect(query.state.login).toBe(false);
  expect(query.state.sessions).toBe(0);
  expect(query.state.terminations).toBeGreaterThan(0);
  expect(app.state.login).toBe(true);
  expect(app.state.sessions).toBe(2);
  expect(app.state.secret).toBe(secret);
  expect(
    await readFile(join(app.root, "knex-application-credential.json"), "utf8"),
  ).toBe(credential);
});

it("refuses inherited PUBLIC schema CREATE for Core application queries without rewriting application ACLs", async () => {
  const f = await fixture();
  f.state.schemaCreate = true;
  const work = vi.fn(async () => undefined);
  await expect(
    withKnexRestrictedRole({ ...f.options, phase: "application_query", work }),
  ).rejects.toThrow();
  expect(work).not.toHaveBeenCalled();
  expect(f.state.schemaCreate).toBe(true);
  expect(f.state.login).toBe(false);
});
