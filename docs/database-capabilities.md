# Database capabilities and conformance design

This maintainer proposal owns the cross-family runtime-driver design requested by
[RDB-159](https://github.com/Ddupasquier/rehearsal-db/issues/159). It is planning only:
no driver, public capability, configuration field, support claim, release prerequisite
or automatic CI gate is enabled by this document. PostgreSQL and Supabase keep their
existing contracts. A listed family is not an implementation commitment.

The owning tracker decides priority and operational authority. The engineering
recommendation below is conditional, not an owner selection. Existing
[project runtime hooks](adapters.md) cannot implement database-family support.

| Navigate               | Sections                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Contract               | [Dimensions](#four-independent-dimensions) · [Negotiation](#proposed-public-negotiation)                                                       |
| Identity and isolation | [Input binding](#identity-baselines-and-exact-consent) · [Ownership](#ownership-and-lifecycle-extension)                                       |
| Families               | [Capability matrix](#capability-matrix-existing-behavior-and-proposed-family-boundaries)                                                       |
| Verification           | [Independent conformance](#reusable-independent-conformance-plan)                                                                              |
| Feasibility            | [Distribution and resources](#distribution-platforms-and-resource-review) · [First slice and estimates](#conditional-first-slice-and-estimate) |

## Existing owners and integration boundary

| Responsibility                                             | Existing owner to reuse                                                                                                                                                                                                                                                                             | Proposed extension                                                                               |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Closed target selection                                    | `src/targets/target.mts`                                                                                                                                                                                                                                                                            | Explicit driver identity; no arbitrary plugins or executable discovery                           |
| Lifecycle dispatch, exact confirmation and failure cleanup | `src/runtime/lifecycle_engine.mts`                                                                                                                                                                                                                                                                  | Keep shared action orchestration; add engine-specific operations behind the target boundary      |
| Primary/dependent selection and collisions                 | `src/runtime/topology.mts`                                                                                                                                                                                                                                                                          | Validate file/database namespaces as well as ports; one independently safe config per target     |
| Configuration validation and paths                         | `src/project/configuration_*.mts`                                                                                                                                                                                                                                                                   | Discriminated family/backend options, strict unknown-key refusal                                 |
| Immutable generations and restore inputs                   | `src/baseline/artifact.mts`, `src/runtime/restore.mts`                                                                                                                                                                                                                                              | Separate versioned native payloads and codecs; preserve old formats                              |
| Ownership, locks and bounded processes                     | `src/targets/docker_resource_ownership.mts`, `src/runtime/local_docker_context.mts`, shared cancellation/process owners                                                                                                                                                                             | Reuse selected-endpoint binding and cooperative coordination; add explicit file/native ownership |
| Privacy and source preparation                             | `src/baseline/privacy_*`, `src/source/`                                                                                                                                                                                                                                                             | Preserve exhaustive policy review; add only verified native types and consistency strategies     |
| Public JSON and editor transport                           | CLI command/output owners and versioned package capabilities                                                                                                                                                                                                                                        | Core owns semantics; editor renders closed supported projections                                 |
| Independent acceptance                                     | Test Lab [expansion coverage](https://github.com/Ddupasquier/rehearsal-test-lab/blob/main/docs/expansion-coverage.md), [runbook](https://github.com/Ddupasquier/rehearsal-test-lab/blob/main/docs/runbook.md), [safety](https://github.com/Ddupasquier/rehearsal-test-lab/blob/main/docs/safety.md) | Exact installed public artifacts and family-specific fixtures in the same development cycle      |

Keep these owners rather than copying either current driver or building a parallel
lifecycle framework. Migration-tool compatibility remains separately scoped by
[RDB-174](https://github.com/Ddupasquier/rehearsal-db/issues/174); an ORM adapter or
PostgreSQL wire protocol is not another database-family qualification.

## Four independent dimensions

1. **Database identity:** family, service/edition, exact server version, driver and
   format versions. Supabase is a service stack using PostgreSQL, not a universal
   Auth/Storage capability of PostgreSQL.
2. **Execution backend:** `offline`, `native` or `container`. Offline means no live
   engine is used for that inspection; it cannot restore or rehearse changes.
   An embedded file uses a native client and `embedded-file` ownership. A native
   server is a different ownership case from an embedded file.
3. **Availability:** `available`, `unavailable` or `unknown`, derived from bounded
   observations with explicit freshness. Installed binaries do not prove a usable
   server, and an unavailable daemon does not prove its VM stopped.
4. **Assurance:** `inspection`, `partial` or `full`, always scoped to the actual
   target, inputs, operations and evidence. Full means the declared rehearsal slice
   was exercised; it never means all vendor features or production behavior.

A feature has one of four states: `supported` (qualified within its stated scope),
`unsupported` (deliberately unavailable), `unknown` (not established), or
`not-applicable` (no meaning for that model). Unknown and unsupported required
features refuse execution. Not applicable is not a successful skipped check.
Availability cannot upgrade a feature's qualification or assurance.

Proposed fixed reasons are `qualified`, `feature_unsupported`,
`qualification_missing`, `not_applicable`, `version_unqualified`,
`backend_unavailable`, `observation_missing`, `ownership_unproven`,
`consent_stale` and `resource_insufficient`. The final schema must validate allowed
state/reason combinations; unknown codes never become successful defaults.

The separate [native-first readiness assessment](https://github.com/users/Ddupasquier/projects/2?pane=issue&itemId=282282672)
reuses these meanings; it owns readiness presentation and backend selection, not
this driver contract. The related [RDB-214](https://github.com/users/Ddupasquier/projects/2?pane=issue&itemId=282282739),
[RDB-215](https://github.com/users/Ddupasquier/projects/2?pane=issue&itemId=282282797)
and [REL-217](https://github.com/users/Ddupasquier/projects/2?pane=issue&itemId=282282918)
must not duplicate this matrix.
There is no silent native-to-container fallback or engine installation. Selection
must remain explicit and reviewed.

## Proposed public negotiation

A future additive package capability `databaseCapabilities: 1` would advertise a
closed schema version, not support for every family. No such capability is added
by this proposal. Preserve current envelopes and existing strict clients; introduce
new fields only in a negotiated projection. New required semantics need a new
capability version rather than reinterpreting an old field.

Proposed report excerpt (one feature shown; not executable configuration or a new CLI):

```json
{
  "schemaVersion": 1,
  "target": "primary",
  "engine": {
    "family": "sqlite",
    "service": "sqlite",
    "version": null
  },
  "backend": "offline",
  "availability": "unknown",
  "assurance": "inspection",
  "capabilities": {
    "restore": {
      "state": "unknown",
      "reason": "qualification_missing"
    }
  }
}
```

The implemented schema should require the complete fixed feature set: snapshot,
restore, schema, migrations, privacy, applicationConnection, recovery, persistence,
cleanup, transactionalDdl, auth and storage. Each has a bounded fixed reason code
and a qualification-scope reference. Null version means unobserved, never latest.
Cap results to 64 features and 32 configured targets; unknown enums, duplicate
features, malformed versions, contradictory states and excess entries refuse.
These are proposed parser bounds, not changes to current limits.

Core keeps private endpoint paths, credentials and detailed ownership evidence out
of the projection. Public reports may expose an opaque binding digest and fixed
reason codes, not SQL, rows, documents, provider text or arbitrary paths. The editor
checks both package capability and report schema, disables unsupported operations,
and leaves offline inspection available where safe. It does not implement a driver,
infer success from an empty result, or soften Core refusal.

## Identity, baselines and exact consent

A future engine-discriminated baseline must bind family, service/edition, exact
producer engine/client versions, codec version, schema/history semantics, payload
checksums, privacy policy and generation identity. The current PostgreSQL-derived
NDJSON/SQL formats must not be silently accepted for SQLite, MySQL or documents.
Use a separately versioned manifest variant; allocate its format number during the
approved implementation, not by reusing another integration's reserved format.

A new engine's baseline history records its actual native ordering/identities and
available historical evidence. Where original applied checksums are absent, state
that explicitly; hashing today's files does not recover historical bytes. The
candidate digest binds the ordered exact current inputs, baseline generation,
configuration, engine identity/version, driver/codec semantics and selected backend.
No SQL translation or cross-family reuse occurs without a separately reviewed,
explicit conversion and its own provenance.

A private runtime receipt additionally binds project/target, resource identity,
selected endpoint or canonical file identity, database namespace, engine instance,
creation/boot evidence and relevant resource limits. Revalidate under the existing
operation lock/lease before mutations and again before recording success. Changed
engine/version, data path, baseline, config or candidate invalidates consent. A
receipt describes a completed observation, not permanent proof against external
changes. Retained receipt protocols must make older incompatible consumers refuse
before reset; compatibility must cover persisted state as well as JSON.

## Capability matrix: existing behavior and proposed family boundaries

`Existing` below means the documented current slice, not a new run in this design.
Every additional family remains unsupported by Rehearsal until separately delivered
and qualified. Native vendor features below inform the design, not product support.

| Family / service                                                                                | Snapshot, schema and restore                                                                                                      | Change execution and recovery                                                                                                                                | Privacy, application and exceptions                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL                                                                                      | Existing reviewed historical SQL plus sanitized rows; this is not a general physical backup or extension clone                    | Exact reviewed migration set; failure cleanup is not proof of SQL rollback; persistent local sandbox and explicit reset/discard                              | Existing relational policy and declared local connection mapping; Supabase Auth/Storage not applicable                                                                                   |
| Supabase                                                                                        | Existing PostgreSQL history/rows plus separately declared verified Auth/Storage behavior                                          | Existing owned service workdir and CLI lifecycle; provider-specific failure and restoration evidence                                                         | Existing identity/runtime/Storage policies; external identity provider success is separate proof                                                                                         |
| SQLite ([160](https://github.com/Ddupasquier/rehearsal-db/issues/160))                          | Proposed consistent native snapshot and fresh owned file; account for journal/WAL/shared-memory and schema dependencies           | Explicit supported SQL history, foreign-key mode and transaction boundaries; preserve failed state and require reviewed reset; no universal rollback promise | Native type/affinity, integer, binary and null fidelity; file path mapping, no server credentials; Auth/Storage not applicable; extensions/encryption initially unsupported              |
| MySQL ([161](https://github.com/Ddupasquier/rehearsal-db/issues/161))                           | Native schema/data ordering, SQL mode, charset/collation, generated/identity values and FK behavior must be qualified             | DDL may implicitly commit; retain dirty/partial state and refuse automatic resume/repair                                                                     | Native JSON/binary/large-number codecs; loopback application credentials; scheduled events and external/server-file behavior must be disabled or refused                                 |
| MariaDB ([162](https://github.com/Ddupasquier/rehearsal-db/issues/162))                         | Separate server/client/format identity and type/collation/generated-column qualification                                          | Independently prove DDL failure/recovery; share MySQL code only for demonstrated equivalent behavior                                                         | Reject MySQL artifacts despite similar protocol; independent privacy and application proofs                                                                                              |
| SQL Server ([163](https://github.com/Ddupasquier/rehearsal-db/issues/163))                      | Edition-specific snapshot/restore, T-SQL batches, schemas, identity/computed columns and binary/numeric types require feasibility | Qualify actual transaction/batch semantics and partial changes; exclude system/unmanaged databases                                                           | Explicit local edition/license consent; reject jobs, linked/external access and instance-wide privileges; CPU/OS constrained                                                             |
| MongoDB ([164](https://github.com/Ddupasquier/rehearsal-db/issues/164))                         | Document-native snapshot, indexes and validators; tagged BSON fidelity rather than lossy ordinary JSON                            | Ordered document-change plan; transaction behavior depends on topology/concern; interrupted partial restore retained                                         | Explicit bounded document privacy and declared references; ObjectId/date/binary/Decimal128 fixtures; TTL/background behavior must be controlled; relational FK capability not applicable |
| [Oracle](oracle-feasibility.md) ([165](https://github.com/Ddupasquier/rehearsal-db/issues/165)) | Feasibility first: schema/restore order, sequences, LOBs, triggers and native types                                               | Explicit directives, DDL and partial-state recovery must be established for the reviewed edition                                                             | Distribution/license/client/CPU/resource decision before any install; reject links/jobs/external effects and instance administration                                                     |

SQLite's [Online Backup API](https://www.sqlite.org/backup.html) exists to obtain
consistent copies; an ordinary live-file copy is not the proposed proof. Its
[WAL documentation](https://www.sqlite.org/wal.html) describes associated WAL/shared-memory
files and same-host coordination, which the embedded fixture must cover. MySQL
[implicit-commit statements](https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html)
preclude a general transaction/rollback claim. MariaDB independently documents
[implicit commits](https://mariadb.com/docs/server/reference/sql-statements/transactions/sql-statements-that-cause-an-implicit-commit);
a MySQL pass cannot qualify its behavior. MongoDB's
[transaction documentation](https://www.mongodb.com/docs/manual/core/transactions/)
distinguishes single-document atomicity from multi-document transaction/topology
semantics. Its [BSON type reference](https://www.mongodb.com/docs/manual/reference/bson-types/)
includes ObjectId, date, binary and Decimal128; ordinary JSON is not a lossless
replacement. Its [topology restrictions](https://www.mongodb.com/docs/manual/core/transactions-production-consideration/)
exclude standalone deployments from transaction support. Never substitute protocol
compatibility for these native contracts.

## Ownership and lifecycle extension

Keep the existing project-operation lock, shared lifecycle admission, explicit
protected-target refusal, exact confirmations and bounded cancellation/cleanup.
Required actions stay reset/start/status/candidates/migrate/verify/run/stop/discard;
an unsupported action refuses before resource mutation. Capability inspection
itself starts no engine and evaluates no project code.

For containers, retain the current explicit local selector/config, endpoint and
daemon binding; full container ID, labels, image identity and exact volume witnesses
must match. Running and stopped foreign resources are preserved. No global prune,
implicit pull, shared shutdown or adopted resource based on name alone. Container
shell retirement and data deletion remain separate operations.

For an embedded file, create only inside a canonical approved owned root, with a
private creation receipt, exclusive creation, no symlink/hard-link aliases, held
parent/file identity and independent source-versus-sandbox proof. Refuse attachment
or equivalent extra-database paths outside the declared sandbox. Bound database,
journal, WAL/shared-memory and temp bytes together; sandbox temp must remain in the
approved storage. Changes from another process invalidate mutation consent. A file
lock from one path spelling is insufficient if another project can reach an alias.

Stop closes only owned handles/children and preserves sandbox bytes. Discard first
proves those handles are gone, then removes only receipt-bound files/sidecars; reset
stages a verified replacement before activation. Lost ownership or uncertain
cancellation preserves evidence/data and reports incomplete cleanup. Same-FD and
ancestry witnesses detect observed races; they are not a filesystem sandbox against
a malicious same-user writer or a guarantee of OS-specific atomic replacement.

For a future native server, require verified process birth/executable, endpoint,
data directory and database namespace ownership, or refuse lifecycle control.
The [owned native PostgreSQL design](native-postgresql-design.md) owns that
backend's proposed privilege, lifecycle and independent acceptance details.
Do not stop an arbitrary listening server merely because it is local. Each non-embedded family needs a separately reviewed native or container backend;
none is selected here. Engine-native plugins, procedures or migration
code need a whole-flow privilege/external-effects review; a clean environment alone
is not an operating-system sandbox.

## Reusable independent conformance plan

This maps the existing ticket's acceptance into future fixture design. It adds no
automatic CI gate and authorizes no runtime run. Use Test Lab's maintained leases,
resource guards and ownership cleanup, with the exact packed public Core artifact;
editor changes additionally need their exact installed VSIX and relevant actual UI
proof. Core unit tests, provider tests and Lab acceptance prove different boundaries.

The smallest relational fixture has two related tables, two parents and three
children, one empty table, a unique index, a nullable value, Unicode, binary bytes,
a high-precision/large numeric value and an explicit historical migration ledger.
An embedded variant adds a held writer/WAL case and an unrelated sibling-file canary.
The document fixture has two collections with declared references, typed BSON values,
one unique compound index and one validator. Include an active TTL negative without
allowing time-driven deletion to masquerade as preservation.

| Case                        | Observable public and independent oracle                                                                                                                                                    |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Restore + migration success | Exact rows/documents and native types/schema/indexes/constraints after restore, then approved new column/field/index and application read/write proof                                       |
| Restore failure             | Truncated payload, wrong digest or incompatible schema refuses; prior baseline pointer and prior sandbox remain unchanged, or exact partial new target is visibly retained                  |
| Rejected and partial change | Native constraint/syntax failure; record which steps committed and dirty state; failed receipt cannot be called rolled back; resume refuses until explicit supported recovery               |
| Interruption and deadline   | Cancel during restore and migration; existing bounded timeout; prove exact child/backend/handle exit, partial-state truth and preserved data; uncertainty retains recovery                  |
| Drift and wrong engine      | Wrong family/version/edition/image/file identity, changed history/config/policy/current input, forged receipt, symlink/hard-link and reordered/duplicate history all refuse before mutation |
| Concurrency                 | Same target, two projects sharing an endpoint/file alias, external writer, occupied port and shared coordination contention; no over-admission or foreign lock stealing                     |
| Session persistence         | Deliberately edit restored data; app stop/start and database stop/start preserve data/Storage and exact data identity even if an owned container shell is recreated                         |
| Reset/discard               | Explicit reset restores only the exact owned sandbox; discard removes only approved owned resources; unrelated running/stopped containers, volumes, files and source fixtures survive       |
| Secrets and side effects    | Canary credentials/rows/documents absent from output/errors; undeclared hosts/paths, plugins, external links, jobs/events and unsafe privileges refuse                                      |
| Compatibility               | Old supported PG/Supabase configs/artifacts still work; old strict clients refuse unknown variants; editor unsupported state stays visible without enabling mutation                        |

Each result records Core/VSIX SHA-256, exact server/image/client/OS/CPU/backend,
fixture schema and inputs, command/result categories, independent preservation
witnesses, recovery/cleanup outcome and untested boundaries. Mocks never certify
native consistency, permissions, transaction semantics, filesystem behavior or real
provider cancellation. Existing unchanged PG/Supabase scenarios may be reused by an
explicit assertion-to-change mapping; no broad rerun is invented for this document.

## Distribution, platforms and resource review

Before enabling any new driver, record exact server/client/build or image digest,
license/edition and redistribution obligations, image architecture, dependency
lock/signature/audit review, supported host/runtime matrix, startup/idle/peak memory,
CPU/PID/disk/temp/output/time budgets, and cleanup ownership. Unknown values block
enabling that scope; a proposed budget is not a measured minimum or waived guard.
Do not install a runtime or accept a vendor license through discovery.

| Family     | Source/licensing and platform facts to carry into review                                                                                                                                                                | Proposed qualification scope; measured budget status                                                                                                             |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SQLite     | Engine source is [public domain](https://www.sqlite.org/copyright.html); a selected binding, extensions and distributed binaries have separate obligations                                                              | Pin exact SQLite and binding; start with one real Linux/CPU combination, then Mac/WSL independently. Bounded file fixture; memory/temp/disk measurements unknown |
| MySQL      | [Community distribution is GPL](https://www.mysql.com/products/community/); client/image and redistribution terms require exact review                                                                                  | Select one maintained exact server/client and native image architecture, local Linux container first; budgets unknown                                            |
| MariaDB    | [Server GPLv2](https://mariadb.org/about/); connector/image terms separately reviewed                                                                                                                                   | Separate exact MariaDB client/server/image qualification; no inherited MySQL pass; budgets unknown                                                               |
| SQL Server | Edition/license and EULA consent unresolved. Microsoft limits [Linux container support to Intel/AMD x86-64 and excludes emulation](https://learn.microsoft.com/en-us/sql/linux/containers/deploy?view=sql-server-ver17) | Defer runtime until permitted edition, x64 runner and resource allocation are reviewed; no Apple Silicon emulation claim; budgets unknown                        |
| MongoDB    | [Community Server SSPL terms](https://www.mongodb.com/legal/licensing/community-edition) and driver/image terms require review; no assumption of permissive redistribution                                              | Select exact native binary/image and one owned topology; transaction coverage may need a replica set; topology/resource measurements unknown                     |
| Oracle     | Exact [Free edition distribution/support limits](https://www.oracle.com/database/free/faq/), client terms and permitted image usage require review; Free is not an assurance of patches or support                      | Defer runtime until exact edition/version/architecture/legal/resource feasibility is decided; budgets unknown                                                    |

Oracle's linked Free FAQ states edition ceilings of two foreground CPUs, 2 GB
combined SGA/PGA and 12 GB user data, and no patches for Free. These are vendor
limits, not measured host/VM minima, approved budgets or a license acceptance.

These upstream references inform planning and must be rechecked for the selected
version at implementation. They are not legal approval, permission to download or
support for all vendor releases. Keep heavy providers serial, use approved external
storage or disposable hosted fixtures, and release owned resources promptly. No
always-on replicas, free-hosting assumption or paid provision is part of this design.

## Conditional first slice and estimate

**Go for design; defer all driver execution and priority selection.** If the owner
later chooses a first expansion, SQLite is the smallest candidate for the proposed
ownership contract because it can exercise native file isolation without an extra
server. This is an engineering comparison, not selection of
[RDB-160](https://github.com/Ddupasquier/rehearsal-db/issues/160). Its first slice
would support one exact reviewed SQLite/binding version, file-backed synthetic
baselines, explicit SQL files, required FK mode, local application path mapping,
persistence/reset/discard, and no extensions/encryption/attached foreign databases.
Snapshot strategy and real concurrency/sidecar proof must be settled first.

Rough engineering estimates below are person-days for one experienced maintainer,
including paired Lab work; they are ranges, not elapsed deadlines, priority or run
authority. They exclude legal waits, runtime provisioning, unrelated features and
unavailable platform/device proof. Re-estimate after a small approved feasibility
slice; there is no blanket total for every database.

| Work                                                                | Estimate                          | Main uncertainty / decision                                                                          |
| ------------------------------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Shared capability/types/closed negotiation + current-driver mapping | 3–5                               | Final API compatibility review and 213 readiness overlap                                             |
| Embedded ownership + SQLite complete narrow slice and Lab           | 8–14 additional                   | Binding choice, consistent snapshots, WAL/OS locking and type fidelity                               |
| MySQL complete narrow container slice and Lab                       | 12–20 additional                  | Native restore/partial DDL, collation/codec and external-effects limits                              |
| MariaDB independent qualification + necessary differences           | 6–12 after MySQL, otherwise 12–20 | Actual semantic differences, version/client evidence                                                 |
| SQL Server feasibility report                                       | 2–4                               | Edition/license, permitted x64 host, resource budget; implementation estimate then 15–25 provisional |
| MongoDB model/codec/consistency design + narrow driver/Lab          | 15–25                             | BSON/privacy semantics, topology and background work                                                 |
| Oracle feasibility report                                           | 3–5                               | Edition/client/license/CPU/resource review; implementation not credibly estimated before that result |

No driver should be enabled from an estimate. For the chosen slice, first approve
exact versions, license/distribution and resource scope; then develop Core, paired
Lab and engine-neutral editor negotiation together. Preserve PG/Supabase behavior
through the existing contract boundary and qualify only the exact delivered scope.
