/** Fixed catalog predicates. They inspect metadata, never evaluate stored SQL. */
type RelationAlias = "r" | "p";
const namespace =
  "(select oid from pg_catalog.pg_namespace where nspname = 'pg_catalog')";
const scalarTypes =
  "('bool', 'int2', 'int4', 'int8', 'numeric', 'float4', 'float8', 'text', 'varchar', 'bpchar', 'uuid', 'date', 'timestamp', 'timestamptz')";

const relationAlias = (value: RelationAlias): RelationAlias => {
  if (value !== "r" && value !== "p")
    throw new Error("The fixed migration-impact catalog alias is unsupported.");
  return value;
};

/** Only bootstrap functions; arbitrary objects merely named pg_catalog do not qualify. */
const nativeProcedure = (oid: string): string => `exists (
  select 1 from pg_catalog.pg_proc mi_proc
  where mi_proc.oid = ${oid} and mi_proc.oid < 16384
    and mi_proc.pronamespace = ${namespace}
    and mi_proc.prokind = 'f' and mi_proc.prolang in (12, 13)
)`;

/** Fixed aliases mi_class/mi_am belong to the enclosing predicate's subquery. */
const nativeClass = (): string => `(
  mi_class.oid < 16384 and mi_class.opcnamespace = ${namespace}
  and mi_class.opcmethod = mi_am.oid
  and mi_am.amtype = 'i'
  and ((mi_am.oid = 403 and mi_am.amname = 'btree')
    or (mi_am.oid = 405 and mi_am.amname = 'hash'))
  and ${nativeProcedure("mi_am.amhandler")}
  and exists (select 1 from pg_catalog.pg_opfamily mi_family
    where mi_family.oid = mi_class.opcfamily and mi_family.oid < 16384
      and mi_family.opfnamespace = ${namespace}
      and mi_family.opfmethod = mi_am.oid
      and not exists (select 1 from pg_catalog.pg_amop mi_member
        where mi_member.amopfamily = mi_family.oid and not (
          mi_member.oid < 16384 and mi_member.amopmethod = mi_am.oid
          and exists (select 1 from pg_catalog.pg_operator mi_operator
            where mi_operator.oid = mi_member.amopopr and mi_operator.oid < 16384
              and mi_operator.oprnamespace = ${namespace}
              and ${nativeProcedure("mi_operator.oprcode")}
              and (mi_operator.oprrest = 0 or ${nativeProcedure("mi_operator.oprrest")})
              and (mi_operator.oprjoin = 0 or ${nativeProcedure("mi_operator.oprjoin")}))
        ))
      and not exists (select 1 from pg_catalog.pg_amproc mi_support
        where mi_support.amprocfamily = mi_family.oid and not (
          mi_support.oid < 16384 and ${nativeProcedure("mi_support.amproc")}
        ))
  )
)`;

/**
 * Even COUNT planning opens indexes, including invalid ones, and may evaluate
 * stored expressions. Permit only plain scalar bootstrap btree/hash metadata.
 * Arrays/composites/domains are excluded because native support can delegate to
 * their element/member operators. This is not protection against a compromised
 * server or privileged replacement of PostgreSQL's bootstrap catalog contents.
 */
export const nativeMigrationImpactIndexes = (alias: RelationAlias): string => {
  const owner = relationAlias(alias);
  return `(not exists (
    select 1 from pg_catalog.pg_index mi_index
    where mi_index.indrelid = ${owner}.oid and (
      mi_index.indexprs is null and mi_index.indpred is null
      and mi_index.indnkeyatts > 0
      and pg_catalog.array_length(mi_index.indkey::pg_catalog.int2[], 1) = mi_index.indnatts
      and pg_catalog.array_length(mi_index.indclass::pg_catalog.oid[], 1) = mi_index.indnkeyatts
      and pg_catalog.array_length(mi_index.indcollation::pg_catalog.oid[], 1) = mi_index.indnkeyatts
      and exists (select 1 from pg_catalog.pg_class mi_index_relation
        join pg_catalog.pg_am mi_am on mi_am.oid = mi_index_relation.relam
        where mi_index_relation.oid = mi_index.indexrelid
          and mi_index_relation.relkind = 'i' and not mi_index_relation.relispartition
          and mi_am.amtype = 'i'
          and ((mi_am.oid = 403 and mi_am.amname = 'btree')
            or (mi_am.oid = 405 and mi_am.amname = 'hash'))
          and ${nativeProcedure("mi_am.amhandler")}
          and not exists (select 1 from pg_catalog.unnest(mi_index.indclass::pg_catalog.oid[]) mi_key(class_oid)
            where not exists (select 1 from pg_catalog.pg_opclass mi_class
              join pg_catalog.pg_type mi_input on mi_input.oid = mi_class.opcintype
              where mi_class.oid = mi_key.class_oid
                and mi_input.oid < 16384 and mi_input.typnamespace = ${namespace}
                and mi_input.typbasetype = 0 and mi_input.typname in ${scalarTypes}
                and ${nativeClass()}))
      )
      and not exists (select 1 from pg_catalog.unnest(mi_index.indkey::pg_catalog.int2[]) mi_key(attribute_number)
        where not exists (select 1 from pg_catalog.pg_attribute mi_attribute
          join pg_catalog.pg_type mi_type on mi_type.oid = mi_attribute.atttypid
          where mi_attribute.attrelid = ${owner}.oid
            and mi_attribute.attnum = mi_key.attribute_number and mi_attribute.attnum > 0
            and not mi_attribute.attisdropped and mi_attribute.attgenerated in ('', 's')
            and mi_type.oid < 16384 and mi_type.typnamespace = ${namespace}
            and mi_type.typbasetype = 0 and mi_type.typname in ${scalarTypes}))
      and not exists (select 1 from pg_catalog.unnest(mi_index.indcollation::pg_catalog.oid[]) mi_key(collation_oid)
        where mi_key.collation_oid <> 0 and not exists (
          select 1 from pg_catalog.pg_collation mi_collation
          where mi_collation.oid = mi_key.collation_oid and mi_collation.oid < 16384
            and mi_collation.collnamespace = ${namespace} and mi_collation.collisdeterministic))
    ) is not true
  ))`;
};

/** PostgreSQL may const-fold expression statistics before consulting their data. */
export const nativeMigrationImpactStatistics = (
  alias: RelationAlias,
): string => {
  const owner = relationAlias(alias);
  return `(not exists (select 1 from pg_catalog.pg_statistic_ext mi_statistics
    where mi_statistics.stxrelid = ${owner}.oid and mi_statistics.stxexprs is not null))`;
};

/**
 * Require one exact native default for each comparison AM. No binary-coercible
 * fallback: varchar/bpchar are deliberately outside comparison recognition.
 */
export const nativeMigrationImpactComparison = (alias: "t"): string => {
  if (alias !== "t")
    throw new Error("The fixed migration-impact catalog alias is unsupported.");
  return `(${[403, 405]
    .map(
      (method) => `(
    (select pg_catalog.count(*) from pg_catalog.pg_opclass mi_default
      where mi_default.opcintype = t.oid and mi_default.opcmethod = ${method}
        and mi_default.opcdefault) = 1
    and exists (select 1 from pg_catalog.pg_opclass mi_class
      join pg_catalog.pg_am mi_am on mi_am.oid = mi_class.opcmethod
      where mi_class.opcintype = t.oid and mi_class.opcdefault
        and mi_am.oid = ${method} and ${nativeClass()})
  )`,
    )
    .join(" and ")})`;
};
