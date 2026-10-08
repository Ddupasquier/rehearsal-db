/**
 * Apply and retire an exact PostgreSQL source-access plan. This module is used
 * only by explicit source commands; ordinary runtime commands must not import it.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import pg from "pg";
import {
  assertSourceAccessConfirmation,
  createSourceRetirementPlan,
  sourceAccessPolicyFingerprint,
  sourceTargetFingerprint,
} from "./access.mjs";
import type {
  SourceAccessPlan,
  SourceRelation,
  SourceRetirementPlan,
} from "./access.mjs";
import { verifyExternalPostgresqlReader } from "./external_reader.mjs";

const { Client } = pg;
const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/u;

interface QueryResultLike {
  readonly rows: Record<string, unknown>[];
}

interface SourceClient {
  connect?(): Promise<void> | void;
  query(query: string, values?: readonly unknown[]): Promise<QueryResultLike>;
  end?(): Promise<void> | void;
}

type SourceClientFactory = (
  connectionString: string,
) => SourceClient | Promise<SourceClient>;

export interface SourceAccessReceipt {
  readonly receiptVersion: 1;
  readonly accessMode: "managed" | "external";
  readonly policyFingerprint: string;
  readonly targetFingerprint: string;
  readonly planDigest: string;
  readonly exportSchema: string;
  readonly views: readonly string[];
  readonly relations: readonly Readonly<{
    schema: string;
    table: string;
    columns: readonly string[];
  }>[];
  readonly migrationLedger: Readonly<{
    schema: string;
    table: string;
    versionColumn: string;
    nameColumn: string;
    statementsColumn: string;
  }>;
  readonly readerRole: string;
  readonly ownerRole?: string;
  readonly expiresAt: string;
}

type ManagedSourceAccessPlan = SourceAccessPlan & {
  readonly policy: SourceAccessPlan["policy"] & {
    readonly administratorEnvironmentVariable: string;
    readonly reader: Extract<
      SourceAccessPlan["policy"]["reader"],
      { mode: "managed" }
    >;
  };
};

type ExternalSourceAccessPlan = SourceAccessPlan & {
  readonly policy: SourceAccessPlan["policy"] & {
    readonly reader: Extract<
      SourceAccessPlan["policy"]["reader"],
      { mode: "external" }
    >;
    readonly relations: readonly (SourceRelation & {
      readonly viewDefinitionSha256: string;
    })[];
  };
};

export interface RetirementExecutionPlan extends SourceRetirementPlan {
  readonly receipt: SourceAccessReceipt;
  readonly receiptPath: string;
}

const quoteIdentifier = (value: string): string => {
  if (!IDENTIFIER.test(value))
    throw new Error("Unsafe source-access identifier.");
  return `"${value}"`;
};

const quoteLiteral = (value: unknown): string =>
  `'${String(value).replaceAll("'", "''")}'`;

const ensureOwnedPath = (projectRoot: string, relativePath: string): string => {
  const root = resolve(projectRoot);
  const path = resolve(root, relativePath);
  const child = relative(root, path);
  if (!child || child.startsWith("..") || isAbsolute(child))
    throw new Error("Source-access file escaped the project root.");
  return path;
};

const isInside = (root: string, path: string): boolean => {
  const child = relative(root, path);
  return Boolean(child) && !child.startsWith("..") && !isAbsolute(child);
};

const resolveSourceStateRoot = ({
  projectRoot,
  artifactRoot = join(projectRoot, ".rehearsal"),
}: {
  projectRoot: string;
  artifactRoot?: string;
}): string => ensureOwnedPath(projectRoot, artifactRoot);

export const resolvePostgresqlSourceStatePaths = ({
  projectRoot = process.cwd(),
  artifactRoot = join(projectRoot, ".rehearsal"),
  credentialFile,
}: {
  projectRoot?: string;
  artifactRoot?: string;
  credentialFile: string;
}) => {
  const stateRoot = resolveSourceStateRoot({ projectRoot, artifactRoot });
  const credentialPath = ensureOwnedPath(projectRoot, credentialFile);
  const secretsRoot = join(stateRoot, "secrets");
  if (!isInside(secretsRoot, credentialPath)) {
    throw new Error(
      "Source reader credential must stay inside this target's configured .rehearsal/secrets directory.",
    );
  }
  return Object.freeze({
    stateRoot,
    credentialPath,
    receiptPath: join(stateRoot, "source-access-receipt.json"),
  });
};

const readerConnectionString = (
  administratorConnectionString: string,
  role: string,
  password: string,
): string => {
  const target = new URL(administratorConnectionString);
  target.username = role;
  target.password = password;
  return target.toString();
};

const writeExclusiveSecret = async (
  path: string,
  content: string,
): Promise<void> => {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, 0o600);
};

const assertSourceStateAvailable = async (
  ...paths: string[]
): Promise<void> => {
  for (const path of paths) {
    try {
      await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      throw error;
    }
    const error = new Error(
      "Source-access state already exists and will not be overwritten.",
    ) as NodeJS.ErrnoException;
    error.code = "EEXIST";
    throw error;
  }
};

const connection = async (
  connectionString: string,
  clientFactory?: SourceClientFactory,
): Promise<SourceClient> => {
  const client = clientFactory
    ? await clientFactory(connectionString)
    : new Client({
        connectionString,
        application_name: "rehearsal-source-access",
      });
  if (typeof client.connect === "function") await client.connect();
  return client as unknown as SourceClient;
};

const sourceRelation = (relation: SourceRelation): string =>
  `${quoteIdentifier(relation.source.schema)}.${quoteIdentifier(relation.source.table)}`;

const viewRelation = (
  plan: SourceAccessPlan,
  relation: SourceRelation,
): string =>
  `${quoteIdentifier(plan.policy.exportSchema)}.${quoteIdentifier(relation.view)}`;

const assertTarget = (
  plan: { policy: { targetFingerprint: string } },
  administratorConnectionString: string,
): void => {
  if (
    sourceTargetFingerprint(administratorConnectionString) !==
    plan.policy.targetFingerprint
  ) {
    throw new Error(
      "Source administrator credential changed to a different target.",
    );
  }
};

const assertUnusedObjects = async (
  client: SourceClient,
  plan: ManagedSourceAccessPlan,
): Promise<void> => {
  const result = await client.query(
    `select
      exists(select 1 from pg_namespace where nspname = $1) as schema_exists,
      exists(select 1 from pg_roles where rolname = $2) as reader_exists,
      exists(select 1 from pg_roles where rolname = $3) as owner_exists`,
    [
      plan.policy.exportSchema,
      plan.policy.reader.role,
      plan.policy.reader.ownerRole,
    ],
  );
  const state = result.rows[0];
  if (!state) throw new Error("Source-access object check was inconclusive.");
  if (state.schema_exists || state.reader_exists || state.owner_exists) {
    throw new Error(
      "Source-access targets already exist. Rehearsal will not overwrite or adopt them.",
    );
  }
};

const assertSourceColumns = async (
  client: SourceClient,
  relation: SourceRelation,
): Promise<void> => {
  const result = await client.query(
    `select column_name
     from information_schema.columns
     where table_schema = $1 and table_name = $2
     order by ordinal_position`,
    [relation.source.schema, relation.source.table],
  );
  if (result.rows.length === 0) {
    throw new Error(
      `Declared source relation ${relation.source.schema}.${relation.source.table} does not exist.`,
    );
  }
  const actual = new Set(result.rows.map((row) => String(row.column_name)));
  const missing = relation.columns.filter((column) => !actual.has(column));
  if (missing.length) {
    throw new Error(
      `Declared source relation is missing ${missing.length} reviewed column(s).`,
    );
  }
};

const runDenyChecks = async (
  client: SourceClient,
  plan: ManagedSourceAccessPlan,
): Promise<void> => {
  const role = plan.policy.reader.role;
  for (const relation of plan.policy.relations) {
    const raw = `${relation.source.schema}.${relation.source.table}`;
    const permissions = await client.query(
      `select
        has_table_privilege($1, $2, 'SELECT') as can_select,
        has_table_privilege($1, $2, 'INSERT') as can_insert,
        has_table_privilege($1, $2, 'UPDATE') as can_update,
        has_table_privilege($1, $2, 'DELETE') as can_delete`,
      [role, raw],
    );
    if (Object.values(permissions.rows[0] ?? {}).some(Boolean)) {
      throw new Error(
        "Source reader unexpectedly has raw-table or write privileges.",
      );
    }
  }
  const escalation = await client.query(
    `select
      pg_has_role($1, $2, 'MEMBER') as owner_member,
      (select rolsuper or rolcreaterole or rolcreatedb or rolreplication or rolbypassrls
       from pg_roles where rolname = $1) as privileged`,
    [role, plan.policy.reader.ownerRole],
  );
  const escalationState = escalation.rows[0];
  if (!escalationState) {
    throw new Error("Source reader escalation check was inconclusive.");
  }
  if (escalationState.owner_member || escalationState.privileged) {
    throw new Error(
      "Source reader unexpectedly has role-escalation privileges.",
    );
  }
  const network = await client.query(
    `select count(*)::integer as exposed
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
     where has_function_privilege($1, p.oid, 'EXECUTE')
       and (n.nspname in ('net', 'http') or p.proname ~* '^(dblink|http|net_)')
       and p.prosecdef`,
    [role],
  );
  if (Number(network.rows[0]?.exposed) > 0) {
    throw new Error(
      "Source reader can execute a security-definer network function.",
    );
  }
};

const assertApprovedOwnerScopes = (
  plan: SourceAccessPlan,
  environment: NodeJS.ProcessEnv,
): void => {
  for (const relation of plan.policy.relations) {
    if (relation.rowScope.kind !== "approved-owner") continue;
    const value = environment[relation.rowScope.valueEnvironmentVariable];
    const reviewedRelation = plan.review.relations.find(
      (entry) => entry.view === relation.view,
    );
    const reviewedValueSha256 =
      reviewedRelation?.rowScope.kind === "approved-owner"
        ? reviewedRelation.rowScope.valueSha256
        : undefined;
    if (
      !value ||
      createHash("sha256").update(value).digest("hex") !== reviewedValueSha256
    ) {
      throw new Error(
        "Approved owner scope changed after the reviewed source-access preview.",
      );
    }
  }
};

const buildSourceAccessReceipt = ({
  plan,
  expiresAt,
}: {
  plan: SourceAccessPlan;
  expiresAt: string;
}): SourceAccessReceipt => ({
  receiptVersion: 1,
  accessMode: plan.policy.reader.mode,
  policyFingerprint: sourceAccessPolicyFingerprint(plan.policy),
  targetFingerprint: plan.policy.targetFingerprint,
  planDigest: plan.digest,
  exportSchema: plan.policy.exportSchema,
  views: plan.policy.relations.map((relation) => relation.view).sort(),
  relations: plan.policy.relations.map((relation) => ({
    ...relation.source,
    columns: relation.columns,
  })),
  migrationLedger: plan.policy.migrationLedger,
  readerRole: plan.policy.reader.role,
  ...(plan.policy.reader.mode === "managed"
    ? { ownerRole: plan.policy.reader.ownerRole }
    : {}),
  expiresAt,
});

const activateExternalPostgresqlSourceAccess = async ({
  plan,
  projectRoot,
  artifactRoot,
  environment,
  clientFactory,
  now,
}: {
  plan: ExternalSourceAccessPlan;
  projectRoot: string;
  artifactRoot: string;
  environment: NodeJS.ProcessEnv;
  clientFactory?: SourceClientFactory;
  now: Date;
}) => {
  const connectionString =
    environment[plan.policy.reader.connectionEnvironmentVariable];
  if (!connectionString) {
    throw new Error(
      `Missing ${plan.policy.reader.connectionEnvironmentVariable}.`,
    );
  }
  assertTarget(plan, connectionString);
  assertApprovedOwnerScopes(plan, environment);
  const { credentialPath, receiptPath } = resolvePostgresqlSourceStatePaths({
    projectRoot,
    artifactRoot,
    credentialFile: plan.policy.reader.credentialFile,
  });
  await assertSourceStateAvailable(credentialPath, receiptPath);
  const verified = await verifyExternalPostgresqlReader({
    plan,
    connectionString,
    ...(clientFactory ? { clientFactory } : {}),
    now,
  });
  const temporaryCredentialPath = `${credentialPath}.building-${process.pid}`;
  const receipt = buildSourceAccessReceipt({
    plan,
    expiresAt: verified.expiresAt,
  });
  let receiptWritten = false;
  try {
    await writeExclusiveSecret(
      temporaryCredentialPath,
      `REHEARSAL_SOURCE_DATABASE_URL=${connectionString}\n`,
    );
    await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    receiptWritten = true;
    await chmod(receiptPath, 0o600);
    await link(temporaryCredentialPath, credentialPath);
    await rm(temporaryCredentialPath, { force: true });
  } catch (error) {
    await rm(temporaryCredentialPath, { force: true });
    if (receiptWritten) await rm(receiptPath, { force: true });
    throw error;
  }
  return { receipt, credentialPath, receiptPath };
};

export const applyPostgresqlSourceAccess = async ({
  plan,
  confirmation,
  projectRoot = process.cwd(),
  artifactRoot = join(projectRoot, ".rehearsal"),
  environment = process.env,
  clientFactory,
  now = new Date(),
}: {
  plan: SourceAccessPlan;
  confirmation: string;
  projectRoot?: string;
  artifactRoot?: string;
  environment?: NodeJS.ProcessEnv;
  clientFactory?: SourceClientFactory;
  now?: Date;
}) => {
  assertSourceAccessConfirmation(plan, confirmation);
  if (plan.policy.reader.mode === "external") {
    return activateExternalPostgresqlSourceAccess({
      plan: plan as ExternalSourceAccessPlan,
      projectRoot,
      artifactRoot,
      environment,
      ...(clientFactory ? { clientFactory } : {}),
      now,
    });
  }
  const managedPlan = plan as ManagedSourceAccessPlan;
  const administratorConnectionString =
    environment[managedPlan.policy.administratorEnvironmentVariable];
  if (!administratorConnectionString) {
    throw new Error(
      `Missing ${managedPlan.policy.administratorEnvironmentVariable}.`,
    );
  }
  assertTarget(managedPlan, administratorConnectionString);
  assertApprovedOwnerScopes(managedPlan, environment);
  const password = randomBytes(32).toString("base64url");
  const expiresAt = new Date(
    now.valueOf() + managedPlan.policy.reader.validForMinutes * 60_000,
  ).toISOString();
  const { credentialPath, receiptPath } = resolvePostgresqlSourceStatePaths({
    projectRoot,
    artifactRoot,
    credentialFile: managedPlan.policy.reader.credentialFile,
  });
  const temporaryCredentialPath = `${credentialPath}.building-${process.pid}`;
  const readerUrl = readerConnectionString(
    administratorConnectionString,
    managedPlan.policy.reader.role,
    password,
  );
  let receiptReserved = false;
  let credentialLinked = false;
  try {
    await writeExclusiveSecret(
      temporaryCredentialPath,
      `REHEARSAL_SOURCE_DATABASE_URL=${readerUrl}\n`,
    );
    const receiptReservation = await open(receiptPath, "wx", 0o600);
    receiptReserved = true;
    await receiptReservation.close();
    await link(temporaryCredentialPath, credentialPath);
    credentialLinked = true;
    await rm(temporaryCredentialPath, { force: true });
  } catch (error) {
    await rm(temporaryCredentialPath, { force: true });
    if (credentialLinked) await rm(credentialPath, { force: true });
    if (receiptReserved) await rm(receiptPath, { force: true });
    throw error;
  }
  let client;
  try {
    client = await connection(administratorConnectionString, clientFactory);
    await client.query("begin");
    await client.query(
      "select pg_advisory_xact_lock(hashtext('rehearsal-source-access'))",
    );
    await assertUnusedObjects(client, managedPlan);
    for (const relation of managedPlan.policy.relations)
      await assertSourceColumns(client, relation);
    await client.query(
      `create role ${quoteIdentifier(managedPlan.policy.reader.ownerRole)}
       nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls`,
    );
    await client.query(
      `create role ${quoteIdentifier(managedPlan.policy.reader.role)}
       login password ${quoteLiteral(password)} valid until ${quoteLiteral(expiresAt)}
       noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls`,
    );
    await client.query(
      `create schema ${quoteIdentifier(managedPlan.policy.exportSchema)}
       authorization ${quoteIdentifier(managedPlan.policy.reader.ownerRole)}`,
    );
    await client.query(
      `revoke all on schema ${quoteIdentifier(managedPlan.policy.exportSchema)} from public`,
    );
    for (const schema of new Set(
      managedPlan.policy.relations.map((relation) => relation.source.schema),
    )) {
      await client.query(
        `grant usage on schema ${quoteIdentifier(schema)}
         to ${quoteIdentifier(managedPlan.policy.reader.ownerRole)}`,
      );
    }
    for (const relation of managedPlan.policy.relations) {
      const columns = relation.columns.map(quoteIdentifier).join(", ");
      await client.query(
        `grant select (${columns}) on ${sourceRelation(relation)}
         to ${quoteIdentifier(managedPlan.policy.reader.ownerRole)}`,
      );
      const filter =
        relation.rowScope.kind === "approved-owner"
          ? ` where ${quoteIdentifier(relation.rowScope.column)} = ${quoteLiteral(environment[relation.rowScope.valueEnvironmentVariable])}`
          : "";
      await client.query(
        `set local role ${quoteIdentifier(managedPlan.policy.reader.ownerRole)}`,
      );
      await client.query(
        `create view ${viewRelation(plan, relation)} with (security_barrier = true) as
         select ${columns} from ${sourceRelation(relation)}${filter}`,
      );
      await client.query("reset role");
      await client.query(
        `revoke all on ${viewRelation(plan, relation)} from public`,
      );
      await client.query(
        `grant select on ${viewRelation(managedPlan, relation)} to ${quoteIdentifier(managedPlan.policy.reader.role)}`,
      );
    }
    await client.query(
      `grant usage on schema ${quoteIdentifier(managedPlan.policy.exportSchema)}
       to ${quoteIdentifier(managedPlan.policy.reader.role)}`,
    );
    const ledger = managedPlan.policy.migrationLedger;
    await client.query(
      `grant usage on schema ${quoteIdentifier(ledger.schema)}
       to ${quoteIdentifier(managedPlan.policy.reader.role)}`,
    );
    await client.query(
      `grant select (${[
        ledger.versionColumn,
        ledger.nameColumn,
        ledger.statementsColumn,
      ]
        .map(quoteIdentifier)
        .join(
          ", ",
        )}) on ${quoteIdentifier(ledger.schema)}.${quoteIdentifier(ledger.table)}
       to ${quoteIdentifier(managedPlan.policy.reader.role)}`,
    );
    await client.query(
      `comment on schema ${quoteIdentifier(managedPlan.policy.exportSchema)} is ${quoteLiteral(
        `rehearsal-source-access:${plan.digest}`,
      )}`,
    );
    await runDenyChecks(client, managedPlan);
    await client.query("commit");
  } catch (error) {
    await client?.query("rollback").catch(() => undefined);
    await Promise.all([
      rm(credentialPath, { force: true }),
      rm(receiptPath, { force: true }),
    ]);
    throw error;
  } finally {
    await client?.end?.();
  }
  const receipt = buildSourceAccessReceipt({ plan, expiresAt });
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "w",
    mode: 0o600,
  });
  await chmod(receiptPath, 0o600);
  return { receipt, credentialPath, receiptPath };
};

export const planPostgresqlSourceAccessRetirement = async ({
  projectRoot = process.cwd(),
  artifactRoot = join(projectRoot, ".rehearsal"),
  targetFingerprint,
}: {
  projectRoot?: string;
  artifactRoot?: string;
  targetFingerprint: string;
}): Promise<RetirementExecutionPlan> => {
  const receiptPath = join(
    resolveSourceStateRoot({ projectRoot, artifactRoot }),
    "source-access-receipt.json",
  );
  const receipt = JSON.parse(
    await readFile(receiptPath, "utf8"),
  ) as SourceAccessReceipt;
  return {
    ...createSourceRetirementPlan({ receipt, targetFingerprint }),
    receipt,
    receiptPath,
  };
};

export const retirePostgresqlSourceAccess = async ({
  plan,
  confirmation,
  administratorEnvironmentVariable,
  projectRoot = process.cwd(),
  artifactRoot = join(projectRoot, ".rehearsal"),
  environment = process.env,
  credentialFile,
  clientFactory,
}: {
  plan: RetirementExecutionPlan;
  confirmation: string;
  administratorEnvironmentVariable?: string;
  projectRoot?: string;
  artifactRoot?: string;
  environment?: NodeJS.ProcessEnv;
  credentialFile: string;
  clientFactory?: SourceClientFactory;
}) => {
  if (confirmation !== plan.digest) {
    throw new Error(
      `Source retirement confirmation does not match. Expected ${plan.digest}.`,
    );
  }
  const { credentialPath, receiptPath } = resolvePostgresqlSourceStatePaths({
    projectRoot,
    artifactRoot,
    credentialFile,
  });
  if (resolve(plan.receiptPath) !== receiptPath) {
    throw new Error(
      "Source retirement receipt does not belong to this target's configured state root.",
    );
  }
  if (plan.review.accessMode === "external") {
    await Promise.all([
      rm(credentialPath, { force: true }),
      rm(receiptPath, { force: true }),
    ]);
    return { retired: true, providerResourcesPreserved: true };
  }
  const ownerRole = plan.review.ownerRole;
  if (!ownerRole) {
    throw new Error("Managed source retirement is missing its owner role.");
  }
  const administratorConnectionString =
    administratorEnvironmentVariable === undefined
      ? undefined
      : environment[administratorEnvironmentVariable];
  if (!administratorConnectionString)
    throw new Error(
      administratorEnvironmentVariable
        ? `Missing ${administratorEnvironmentVariable}.`
        : "Managed source retirement requires an administrator environment variable.",
    );
  assertTarget(
    { policy: { targetFingerprint: plan.review.targetFingerprint } },
    administratorConnectionString,
  );
  const client = await connection(administratorConnectionString, clientFactory);
  try {
    await client.query("begin");
    await client.query(
      "select pg_advisory_xact_lock(hashtext('rehearsal-source-access'))",
    );
    const inventory = await client.query(
      `select c.relname,
              obj_description(n.oid, 'pg_namespace') as schema_comment
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = $1 and c.relkind in ('v', 'm')
       order by c.relname`,
      [plan.review.exportSchema],
    );
    if (
      inventory.rows.map((row) => row.relname).join("\0") !==
      plan.review.views.join("\0")
    ) {
      throw new Error(
        "Source export schema changed after preparation; retirement stopped.",
      );
    }
    if (
      inventory.rows.some(
        (row) =>
          row.schema_comment !==
          `rehearsal-source-access:${plan.review.preparationDigest}`,
      )
    ) {
      throw new Error("Source export schema ownership receipt does not match.");
    }
    for (const view of plan.review.views) {
      await client.query(
        `drop view ${quoteIdentifier(plan.review.exportSchema)}.${quoteIdentifier(view)}`,
      );
    }
    await client.query(
      `drop schema ${quoteIdentifier(plan.review.exportSchema)} restrict`,
    );
    for (const relation of plan.receipt.relations) {
      await client.query(
        `revoke select (${relation.columns.map(quoteIdentifier).join(", ")})
         on table ${quoteIdentifier(relation.schema)}.${quoteIdentifier(relation.table)}
         from ${quoteIdentifier(ownerRole)}`,
      );
    }
    for (const schema of new Set(
      plan.receipt.relations.map((relation) => relation.schema),
    )) {
      await client.query(
        `revoke usage on schema ${quoteIdentifier(schema)}
         from ${quoteIdentifier(ownerRole)}`,
      );
    }
    const ledger = plan.receipt.migrationLedger;
    await client.query(
      `revoke all privileges on table ${quoteIdentifier(ledger.schema)}.${quoteIdentifier(ledger.table)}
       from ${quoteIdentifier(plan.review.readerRole)}`,
    );
    await client.query(
      `revoke usage on schema ${quoteIdentifier(ledger.schema)}
       from ${quoteIdentifier(plan.review.readerRole)}`,
    );
    await client.query(`drop role ${quoteIdentifier(plan.review.readerRole)}`);
    await client.query(`drop role ${quoteIdentifier(ownerRole)}`);
    await client.query("commit");
    const remaining = await client.query(
      `select
        exists(select 1 from pg_namespace where nspname = $1) as schema_exists,
        exists(select 1 from pg_roles where rolname = $2) as reader_exists,
        exists(select 1 from pg_roles where rolname = $3) as owner_exists`,
      [plan.review.exportSchema, plan.review.readerRole, ownerRole],
    );
    if (Object.values(remaining.rows[0] ?? {}).some(Boolean)) {
      throw new Error(
        "Source access retirement could not be independently verified.",
      );
    }
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end?.();
  }
  await Promise.all([
    rm(credentialPath, { force: true }),
    rm(receiptPath, { force: true }),
  ]);
  return { retired: true };
};
