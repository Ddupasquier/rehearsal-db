/** Validate opt-in effective privileges and build catalog-only verification checks. */

const IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/u;
const TYPE_IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/u;
const PRIVILEGES = {
  schema: ["CREATE", "USAGE"],
  table: [
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "TRUNCATE",
    "REFERENCES",
    "TRIGGER",
    "MAINTAIN",
  ],
  sequence: ["USAGE", "SELECT", "UPDATE"],
  function: ["EXECUTE"],
} as const;
const COLUMN_PRIVILEGES = new Set(["SELECT", "INSERT", "UPDATE", "REFERENCES"]);

export interface RuntimePrivilegeArgumentType {
  readonly schema: "pg_catalog";
  readonly name: string;
}

interface RuntimePrivilegeBase {
  readonly schema: string;
  readonly role: string;
  readonly required: readonly string[];
  readonly forbidden: readonly string[];
}

export type RuntimePrivilege = RuntimePrivilegeBase &
  (
    | { readonly kind: "schema" }
    | { readonly kind: "table" | "sequence"; readonly name: string }
    | {
        readonly kind: "function";
        readonly name: string;
        readonly argumentTypes: readonly RuntimePrivilegeArgumentType[];
      }
  );

const object = (value: unknown, label: string): Record<string, unknown> => {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
};

const keys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void => {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error(`${label} contains unsupported fields.`);
};

const identifier = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !IDENTIFIER.test(value))
    throw new Error(`${label} is not a safe PostgreSQL identifier.`);
  return value;
};

const permissions = (
  value: unknown,
  allowed: readonly string[],
  label: string,
): readonly string[] => {
  if (
    !Array.isArray(value) ||
    value.length > allowed.length ||
    value.includes(undefined) ||
    value.some(
      (entry) => typeof entry !== "string" || !allowed.includes(entry),
    ) ||
    new Set(value).size !== value.length
  ) {
    throw new Error(`${label} must contain distinct supported privileges.`);
  }
  return Object.freeze([...value] as string[]);
};

export const validateRuntimePrivileges = (
  input: unknown,
): readonly RuntimePrivilege[] => {
  if (
    !Array.isArray(input) ||
    input.length > 1_024 ||
    input.includes(undefined)
  )
    throw new Error(
      "runtimePolicy.privileges must be an array of at most 1024 declarations.",
    );
  const observed = new Map<
    string,
    { required: Set<string>; forbidden: Set<string> }
  >();
  return Object.freeze(
    input.map((value, index): RuntimePrivilege => {
      const label = `runtimePolicy.privileges[${index}]`;
      const entry = object(value, label);
      if (
        typeof entry.kind !== "string" ||
        !Object.hasOwn(PRIVILEGES, entry.kind)
      ) {
        throw new Error(`${label}.kind is unsupported.`);
      }
      const kind = entry.kind as keyof typeof PRIVILEGES;
      keys(
        entry,
        [
          "kind",
          "schema",
          "role",
          "required",
          "forbidden",
          ...(kind === "schema" ? [] : ["name"]),
          ...(kind === "function" ? ["argumentTypes"] : []),
        ],
        label,
      );
      const schema = identifier(entry.schema, `${label}.schema`);
      const role = identifier(entry.role, `${label}.role`);
      const allowed: readonly string[] = PRIVILEGES[kind];
      const required = permissions(
        Object.hasOwn(entry, "required") ? entry.required : [],
        allowed,
        `${label}.required`,
      );
      const forbidden = permissions(
        Object.hasOwn(entry, "forbidden") ? entry.forbidden : [],
        allowed,
        `${label}.forbidden`,
      );
      if (required.length + forbidden.length === 0)
        throw new Error(
          `${label} must declare a required or forbidden privilege.`,
        );
      const base = { schema, role, required, forbidden };
      let normalized: RuntimePrivilege;
      if (kind === "schema") normalized = Object.freeze({ ...base, kind });
      else {
        const name = identifier(entry.name, `${label}.name`);
        if (kind !== "function")
          normalized = Object.freeze({ ...base, kind, name });
        else {
          if (
            !Array.isArray(entry.argumentTypes) ||
            entry.argumentTypes.length > 32 ||
            entry.argumentTypes.includes(undefined)
          )
            throw new Error(
              `${label}.argumentTypes must be an array of at most 32 types.`,
            );
          const argumentTypes = entry.argumentTypes.map(
            (value, argumentIndex) => {
              const typeLabel = `${label}.argumentTypes[${argumentIndex}]`;
              const type = object(value, typeLabel);
              keys(type, ["schema", "name"], typeLabel);
              if (
                type.schema !== "pg_catalog" ||
                typeof type.name !== "string" ||
                !TYPE_IDENTIFIER.test(type.name)
              ) {
                throw new Error(
                  `${typeLabel} must name a safe pg_catalog type.`,
                );
              }
              return Object.freeze({
                schema: "pg_catalog" as const,
                name: type.name,
              });
            },
          );
          normalized = Object.freeze({
            ...base,
            kind,
            name,
            argumentTypes: Object.freeze(argumentTypes),
          });
        }
      }
      const identity = JSON.stringify([
        kind,
        schema,
        normalized.kind === "schema" ? null : normalized.name,
        role,
        normalized.kind === "function" ? normalized.argumentTypes : null,
      ]);
      const earlier = observed.get(identity) ?? {
        required: new Set<string>(),
        forbidden: new Set<string>(),
      };
      if (
        required.some(
          (privilege) =>
            forbidden.includes(privilege) || earlier.forbidden.has(privilege),
        ) ||
        forbidden.some((privilege) => earlier.required.has(privilege))
      ) {
        throw new Error(
          `${label} has overlapping required and forbidden privileges.`,
        );
      }
      required.forEach((privilege) => earlier.required.add(privilege));
      forbidden.forEach((privilege) => earlier.forbidden.add(privilege));
      observed.set(identity, earlier);
      return normalized;
    }),
  );
};

const literal = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const typeLookup = (type: RuntimePrivilegeArgumentType): string =>
  `select t.oid from pg_catalog.pg_type t
      join pg_catalog.pg_namespace n on n.oid = t.typnamespace
      where n.nspname = 'pg_catalog' and t.typname = ${literal(type.name)}`;

const objectLookup = (entry: RuntimePrivilege): string => {
  if (entry.kind === "schema")
    return `select n.oid into rehearsal_object from pg_catalog.pg_namespace n
    where n.nspname = ${literal(entry.schema)};`;
  if (entry.kind === "function")
    return `select p.oid into rehearsal_object from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = ${literal(entry.schema)} and p.proname = ${literal(entry.name)}
      and p.prokind = 'f' and p.pronargs = ${entry.argumentTypes.length}
      ${entry.argumentTypes.map((type, index) => `and p.proargtypes[${index}] = (${typeLookup(type)})`).join("\n      ")};`;
  return `select c.oid into rehearsal_object from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${literal(entry.schema)} and c.relname = ${literal(entry.name)}
      and c.relkind ${entry.kind === "sequence" ? "= 'S'" : "in ('r', 'p', 'v', 'm', 'f')"};`;
};

const permissionCheck = (
  entry: RuntimePrivilege,
  privilege: string,
  forbidden: boolean,
): string => {
  const functionName = `pg_catalog.has_${entry.kind}_privilege`;
  const tableCheck = `${functionName}(rehearsal_role, rehearsal_object, ${literal(privilege)})`;
  const expression =
    entry.kind === "table" && forbidden && COLUMN_PRIVILEGES.has(privilege)
      ? `(${tableCheck} or pg_catalog.has_any_column_privilege(rehearsal_role, rehearsal_object, ${literal(privilege)}))`
      : tableCheck;
  const evaluation =
    privilege === "MAINTAIN"
      ? `if pg_catalog.current_setting('server_version_num')::integer < 170000 then
      rehearsal_allowed := false;
    else
      rehearsal_allowed := ${expression};
    end if;`
      : `rehearsal_allowed := ${expression};`;
  return `${evaluation}
    if rehearsal_allowed is null then
      raise exception 'Rehearsal privilege object is unavailable';
    end if;
    if rehearsal_allowed is ${forbidden ? "true" : "false"} then
      raise exception 'Rehearsal ${forbidden ? "forbidden privilege is present" : "required privilege is missing"}';
    end if;`;
};

/** Blocks are embedded inside the policy verifier; no ACL or object writes are emitted. */
export const buildRuntimePrivilegeVerificationChecks = (
  entries: readonly RuntimePrivilege[],
): readonly string[] =>
  entries.map(
    (entry) => `declare
    rehearsal_role pg_catalog.oid;
    rehearsal_object pg_catalog.oid;
    rehearsal_allowed boolean;
  begin
    select r.oid into rehearsal_role from pg_catalog.pg_roles r
    where r.rolname = ${literal(entry.role)};
    if rehearsal_role is null then
      raise exception 'Rehearsal privilege role is missing';
    end if;
    ${
      entry.kind === "function"
        ? entry.argumentTypes
            .map(
              (type) => `if not exists (${typeLookup(type)}) then
      raise exception 'Rehearsal privilege argument type is missing';
    end if;`,
            )
            .join("\n    ")
        : ""
    }
    ${objectLookup(entry)}
    if rehearsal_object is null then
      raise exception 'Rehearsal privilege object is missing';
    end if;
    ${entry.required.map((privilege) => permissionCheck(entry, privilege, false)).join("\n    ")}
    ${entry.forbidden.map((privilege) => permissionCheck(entry, privilege, true)).join("\n    ")}
  end;`,
  );
