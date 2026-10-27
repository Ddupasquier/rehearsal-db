# Oracle Database local-driver feasibility

This report satisfies the planning scope of
[RDB-165](https://github.com/Ddupasquier/rehearsal-db/issues/165). It adds no driver,
configuration, executable capability or runtime qualification. The
[database capability and conformance design](database-capabilities.md) remains the
cross-family owner; its identity, consent, lifecycle and evidence requirements apply
without duplicating that matrix here. PostgreSQL/Supabase behavior is unchanged.

**Recommendation: defer Oracle driver implementation and support; retain a conditional
local-only qualification route.** Official local distributions and a client without
Instant Client make a narrow prototype technically plausible. License consent,
immutable image/client verification, measured resource fit and whole-flow privilege,
codec and failure-recovery proof remain unresolved. This report neither selects the
first expansion driver nor approves a runtime run. No Oracle software was downloaded,
installed or executed; no license was accepted. Primary documentation and public
release metadata were reviewed on 2026-10-26.

| Navigate                 | Sections                                                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Candidate and permission | [Distribution and platform facts](#distribution-and-platform-facts) · [Resource accounting](#resource-accounting)                                                                    |
| Data and execution       | [Baseline and least privilege](#baseline-and-least-privilege) · [Types and restore order](#types-and-restore-order) · [Migration failures](#migration-failures-and-external-effects) |
| Independent proof        | [Disposable fixture plan](#reproducible-disposable-fixture-plan-not-executed)                                                                                                        |
| Decision                 | [Estimate and exit criteria](#estimate-and-exit-criteria)                                                                                                                            |

## Distribution and platform facts

The engineering candidate for a later separately approved investigation is **Oracle
AI Database 26ai Free, 23.26.3**, with an exact architecture-specific official image
and **node-oracledb 26.0.0 Thin mode**. These are research candidates, not supported
Rehearsal versions. Enterprise/Standard Edition, Autonomous Database, old XE releases,
Thick mode and community-repacked images are outside the initial proposal.

| Observation from primary source                                                                                                                                                                                                 | Consequence for the proposed slice                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Oracle's [Free quick start](https://www.oracle.com/database/free/get-started/) lists 23.26.3 Linux x86-64 and ARM RPMs, Windows x64 and Oracle Container Registry delivery                                                      | Prefer a reviewed existing local Linux container image for a later fixture; do not install RPMs or change host kernel settings                                                                                                                        |
| The official [registry repository](https://container-registry.oracle.com/ords/ocr/ba/database/free) lists `23.26.3.0-amd64` and `23.26.3.0-arm64`, with separate lite variants                                                  | Initially consider the full amd64 variant; resolve and verify the full platform manifest/config digest before any pull/run. No digest or image signature/layer has been qualified here; do not use mutable `latest` or silently substitute lite       |
| Oracle's [container build documentation](https://github.com/oracle/docker-images/blob/main/OracleDatabase/SingleInstance/README.md) supports Free ARM64 and fixes Free's SID to `FREE`; its examples distinguish `FREEPDB1`     | Start with one Linux x64 engine and exact owned PDB service, then independently qualify ARM64. CPU/image availability is not Mac/WSL certification                                                                                                    |
| [Linux requirements](https://docs.oracle.com/en/database/oracle/oracle-database/26/xeinl/requirements.html) specify supported Oracle Linux/RHEL combinations; ARM needs Neoverse N1 capability                                  | A generic Linux or ARM label is insufficient. Record actual kernel/CPU/image/virtualization; do not claim emulation support                                                                                                                           |
| [Oracle's client guide](https://node-oracledb.readthedocs.io/en/latest/user_guide/installation.html) describes Thin mode without Oracle Client libraries and says no native Oracle Database exists for macOS                    | A Mac client may connect to a separately qualified local Linux VM/container; it does not enable a native Mac server. Existing Rehearsal native-Windows refusals remain                                                                                |
| Oracle published [node-oracledb 26.0.0](https://github.com/oracle/node-oracledb/releases/tag/v26.0.0); its [package metadata](https://github.com/oracle/node-oracledb/blob/v26.0.0/package.json) declares Apache-2.0 OR UPL-1.0 | Review the exact npm artifact, integrity, dependencies and install behavior before a future installation. Do not infer Thin-mode qualification from package installation or vendor minimum Node support; use an already supported Rehearsal Node line |

The registry's short URL can redirect through a dynamic page. Public indexed tag
metadata was available during research, but no authenticated registry manifest or
image bytes were retrieved. Resolving immutable identity is an explicit outstanding
step, not a manufactured digest or permission to download.

### License consent and distribution

The selected repository identifies **Oracle Free Use Terms and Conditions**, not an
assumed permissive open-source server license. The
[terms](https://www.oracle.com/downloads/licenses/oracle-free-license.html) describe
conditional internal use and unmodified redistribution, notice/license obligations,
and separately licensed components. Applicable existing Oracle agreements may alter
which terms govern. Record the exact program/image, terms and component notices,
intended internal testing use, recipient and explicit authorized consent before
acquiring or using it. This is not legal approval or blanket distribution consent.

Do not bundle Oracle server binaries in the Core npm package, upload images to a
public mirror, accept registry terms through discovery, or infer hosting rights from
“Free.” The [Free FAQ](https://www.oracle.com/database/free/faq/) states that Free has
no support service requests or patches, including security patches. That limits any
future maintenance promise; published new builds do not establish a patch-support
commitment. No current vulnerability or categorical technical impossibility is
established by this report.

The license also describes possible installation/auto-update information collection.
Review the exact image/client producers and deny undeclared downloads, updates or
outbound requests before any later start; an offline-use intention is not evidence
that a selected image is network-silent.

## Resource accounting

Keep installation prerequisites, edition ceilings, image storage and host/VM
headroom separate. Oracle's [Linux installation requirements](https://docs.oracle.com/en/database/oracle/oracle-database/26/xeinl/requirements.html)
state **1 GB RAM minimum, 2 GB recommended, 10 GB disk minimum**, plus recommended
swap of 2 GB or twice RAM, whichever is less. They do not provide a universal minimum
core count or a Rehearsal workload measurement. Native installation requires root
and can configure persistent kernel parameters; it is not proposed here.

The [Free restrictions](https://docs.oracle.com/en/database/oracle/oracle-database/26/xeinl/licensing-restrictions.html)
cap processing at two cores, database RAM at 2 GB and user data at 12 GB. They allow
only one installation per logical environment, including a container/VM. These are
ceilings and restrictions, not a 2 GB complete-container/VM budget or 12 GB total-disk
reservation. Source and target would require distinct owned logical environments,
subject to the actual license review, not two installations in one environment.

A later proposed single-server pilot envelope is at most **2 vCPU, 4 GiB container
memory and 30 GiB reserved external storage** for image expansion, data, redo/undo,
temp and evidence. These are planning caps, not measured sufficiency or approved
settings. Admit one server at a time; stop and prove source exit before target boot
when possible. Preserve source storage until target verification. Any need for
simultaneous source/target must account for both peaks and obtain its own resource
review. Existing host pressure, machine/engine headroom, leases and disk guards may
refuse this envelope and must never be weakened to fit it.

Actual startup, idle/restore/migration peaks, client RSS, PID count, disk amplification,
LOB temp use and server/backend cancellation latency are **unknown**. A later pilot
must set explicit startup, statement, total-phase, output and cleanup deadlines under
existing owners before running; this report grants no timer increases. Failure to
fit a reviewed envelope means defer or narrow the slice, not automatic retry. No
always-running instance, new VM, cloud account or paid resource is required by this
report.

## Baseline and least privilege

Initial feasibility should use only authored synthetic data in a newly owned local
source, not hosted/production extraction. A proposed Oracle-specific manifest variant
would bind exact edition/server/client/image architecture, PDB identity, character
sets, native type/codec version, ordered migration bytes, recorded successful history,
privacy policy and baseline generation. Allocate its format only in an approved
implementation. Existing PG/Supabase artifacts are incompatible, not converted.
Oracle has no universal application migration ledger; define the initial reviewed
SQL-history contract explicitly and never fabricate framework/native history.

For an eventual local snapshot, use a dedicated separately authenticated reader with
`CREATE SESSION` and object-scoped `READ` on approved base tables or reviewed views,
no `ANY`/DBA/catalog-wide or directory grants. Oracle's
[GRANT reference](https://docs.oracle.com/en/database/oracle/oracle-database/26/sqlrf/GRANT.html)
distinguishes table `READ` from `SELECT ... FOR UPDATE`. Effective grants, roles,
PUBLIC exposure and view/function reachability need independent deny tests, not just
a role name. Do not use `SYS` for capture.

Oracle's [read-only transaction](https://docs.oracle.com/en/database/oracle/oracle-database/26/sqlrf/SET-TRANSACTION.html)
provides a consistent data snapshot across queries; it must start the transaction,
and its consistency does not apply to `SYS`. Keep all row/LOB reads on that bounded
transaction and fail on undo/snapshot exhaustion. Require reviewed DDL and sequence
writers quiescent in the owned source, compare schema/type metadata before and after,
and bind that observation. Sequences advance independently of commit/rollback, so
a row snapshot alone cannot prove sequence state. If source consistency or metadata
coverage cannot be established, refuse activation and retain the previous baseline.

Data Pump is **not the initial implementation shortcut**. Oracle's
[Data Pump overview](https://docs.oracle.com/en/database/oracle/oracle-database/26/sutil/oracle-data-pump-overview.html)
describes privileged directory/full-database roles and native dump compatibility.
A later Data Pump or Flashback-SCN source mode needs separate least-privilege,
file-output, type/privacy and consistency design; unfiltered dumps must not bypass
the exhaustive sanitization pipeline. No dump utility is run in this task.

Restore/migration/application sessions must authenticate as the limited owned PDB
schema user, not as `SYS`, `SYSTEM` or a privileged session temporarily using another
role. Bootstrap administration is confined to fixed package-owned instance/user
control and catalog checks; it must not evaluate imported user-schema expressions.
Inspect effective package/external privileges before restoring or executing anything;
if containment cannot be demonstrated, the proposed slice remains unsupported.

Application configuration would map only a reviewed loopback host, leased port,
exact PDB service, schema user and private password into declared environment names
(such as `ORACLE_CONNECT_STRING`, `ORACLE_USER`, `ORACLE_PASSWORD`). These are proposed
mappings, not new executable configuration keys. Reject CDB-root/admin connections,
remote descriptors, inherited TNS/wallet/cloud configuration and failover endpoints.
Passwords stay out of argv, public metadata and logs; no admin credentials reach the
application. Exact supported secret injection must be reviewed with the chosen image.

## Types and restore order

Oracle's [native types](https://docs.oracle.com/en/database/oracle/oracle-database/26/sqlrf/Data-Types.html)
need a versioned codec. The initial proposal below is deliberately narrow; every
included column still needs reviewed privacy treatment and exact round-trip proof.

| Native shape                        | Proposed representation and privacy boundary                                                                                                                                                                                                                                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NUMBER(p,s)` / integer identifiers | Canonical decimal strings with precision/scale metadata; never silently round through JavaScript numbers. Deterministic identity mappings preserve declared FK relationships                                                                                                                                                    |
| `VARCHAR2` / `NVARCHAR2` / `CHAR`   | Explicit character set, byte/character length semantics and Unicode bounds; preserve padding semantics. Oracle treats zero-length character values as null, as its [null reference](https://docs.oracle.com/en/database/oracle/oracle-database/26/sqlrf/Nulls.html) documents; do not invent a distinct empty-string round trip |
| `DATE` / plain `TIMESTAMP`          | Preserve time-of-day and declared fractional precision through explicit bound formats, not locale-dependent strings or a lossy JavaScript date. Region/local-time-zone timestamp support remains unknown initially                                                                                                              |
| `RAW` / `BLOB`                      | Exact bounded bytes, payload hashes and streaming; binary privacy is explicit keep/drop/replace, not automatic text parsing                                                                                                                                                                                                     |
| `CLOB` / `NCLOB`                    | Bounded streaming with per-value/aggregate limits and Unicode/privacy rules. The [driver LOB guide](https://node-oracledb.readthedocs.io/en/latest/user_guide/lob_data.html) distinguishes character/binary LOBs from external-file `BFILE`; never buffer arbitrary LOBs or follow server files                                 |
| Unsupported initially               | `BFILE`, external tables, `LONG`/`LONG RAW`, user-defined object/collection types, XML/spatial/vector/native-JSON types and unqualified timezone semantics refuse; listing them is not support                                                                                                                                  |

Proposed restore ordering is reviewed prerequisite schema, sequences and base tables;
parent-before-child rows and bounded LOBs; identity/sequence restoration under a
qualified method; indexes/constraints with actual validation; then exact reviewed
simple triggers and final application invariants. Do not disable triggers or FK
checks globally and declare success without validating their final state. Generated
identity modes, sequence cache/gaps and trigger-derived values need separate fixtures;
`MAX(id)+1` is not a general sequence backup method. Oracle's
[sequence reference](https://docs.oracle.com/en/database/oracle/oracle-database/26/sqlrf/CREATE-SEQUENCE.html)
explicitly makes sequence allocation independent of transaction outcome.

## Migration failures and external effects

Oracle's [COMMIT contract](https://docs.oracle.com/en/database/oracle/oracle-database/26/sqlrf/COMMIT.html)
commits before syntactically valid DDL even when it fails, and after successful DDL.
Do not wrap a migration in `BEGIN`/`ROLLBACK` and promise PostgreSQL-like atomicity.
A candidate records ordered unit hashes, dispatch/result state and dirty/partial
status; interrupted or failed history blocks automatic resume. Preserve target data
and recovery evidence until explicit reviewed reset/discard. A client error or closed
socket is not proof that the server stopped or rolled back.

Use a qualified native SQL/PLSQL unit reader and driver binding, not shelling reviewed
files into SQL*Plus. Its [command reference](https://docs.oracle.com/en/database/oracle/oracle-database/26/sqlqr/SQL-Plus-Commands.html)
includes host commands and instance control. Initial inputs must explicitly reject
`HOST`, `CONNECT`, includes, `SPOOL`, SQLcl commands, substitutions and unqualified
slash/batch directives; semicolon splitting is not a PL/SQL parser. Whole-file and
ordered-unit digests must match consent before dispatch. Supporting other migration
tools or arbitrary scripts requires separately scoped integration.

The target policy must refuse database links, scheduler/external jobs, directory/file
objects, external libraries/procedures/tables, network packages or Java execution,
privileged/definer escalation, instance administration and unreviewed plugins. Verify
actual effective privileges and external-access denials with a separate canary, not
only a textual SQL scan or a container label. Do not change existing source/app/PUBLIC
ACLs to make an unsafe source pass. Imported triggers/defaults must never gain an
administrative execution context during restore or verification.

The driver's [call timeout](https://node-oracledb.readthedocs.io/en/latest/api_manual/connection.html#connection-calltimeout)
is per network round trip, not a total operation deadline. A future implementation
must combine the existing total cancellation owner, bounded connection/statement
work, tracked backend/session identity and independently confirmed backend absence.
If cleanup or privilege proof is unknown, preserve the owned target and report it;
never delete evidence or report success just because the client exited.

## Reproducible disposable fixture plan (not executed)

This extends the [shared independent conformance plan](database-capabilities.md#reusable-independent-conformance-plan),
not a new mandatory CI gate. Test Lab owns its maintained
[resource/cleanup guards](https://github.com/Ddupasquier/rehearsal-test-lab/blob/main/docs/safety.md)
and [feature acceptance](https://github.com/Ddupasquier/rehearsal-test-lab/blob/main/docs/expansion-coverage.md).
A later run needs separate operational authority and exact installed public artifacts.

1. **Preflight:** record explicit license consent, platform image manifest/config
   digest, exact server/client/Node/Core artifact versions and hashes, scripts/audit
   review and resource envelope. Use an already reviewed local engine, not automatic
   installation/pull. Acquire existing heavy/port leases and preserve unrelated
   running/stopped resources. A missing prerequisite refuses before target creation.
2. **Owned source:** one nonce-labelled container and data volume, one instance in
   that logical environment, exact `FREEPDB1` service and nonce-owned schema. Do not
   adopt a container/schema by name. Only loopback listener mapping; no Docker socket,
   arbitrary host folders or user startup/setup script mounts. Bind full container,
   image, volume, selected daemon, PDB identity and fixed receipt protocol. Oracle's
   container example uses `/opt/oracle/oradata`; its UID/permissions and exact image
   mount contract must be verified, not copied into a generic cleanup assumption.
3. **Synthetic fixture:** two parents, three FK-linked children, unique/check/not-null
   constraints, one empty table, a sequence with a deliberate rolled-back allocation,
   a generated identity, a reviewed local audit trigger, Unicode, null, high-precision
   decimal, fractional timestamp, RAW and bounded CLOB/NCLOB/BLOB values. Use 1 MiB
   binary/text LOB cases and a proposed 16 MiB total synthetic payload ceiling.
   A genuine source run, not fabricated receipt, produces successful history.
4. **Capture:** verify reader privilege denials, one non-SYS read-only snapshot,
   schema/sequence quiescence and exhaustive privacy coverage. Hash independent typed
   source oracles and immutable artifact; keep rows/passwords out of reports. Stop
   only the owned source before target boot where the memory envelope requires it.
5. **Target success:** public baseline/reset/candidates/consented migration/verify/run
   must restore typed rows, constraints, sequence/identity behavior, audit trigger and
   real application read/write proof. Compare independent typed hashes and expected
   values, not only counts or process exit. No Oracle feature is supported yet.
6. **Deliberate failures:** truncated/digest-changed LOB, unsupported type, wrong PDB
   or image/daemon, changed source/config/order, duplicate history, missing consent
   and existing unowned volume must refuse. Apply one successful DDL followed by a
   failing DDL and prove partial schema/dirty-state truth. Attempt forbidden external
   jobs/links/files/network and privilege paths; the canary must show denial.
7. **Interruptions and persistence:** cancel mid-LOB restore and during a genuinely
   observed long server statement; exercise bounded timeout separately. Confirm exact
   backend/child absence, preserved data/volume/baseline and honest recovery. Edit
   sandbox rows, then app stop/start and database stop/start; verify edits persist.
   Two simultaneous public operations on the same target must contend through
   existing coordination; an independently owned instance/schema canary must never
   be adopted or changed. Include an actual row-lock contention timeout case.
   Reset restores only that sandbox; scoped discard and failure cleanup preserve
   source evidence and unrelated schemas/containers/volumes/files.
8. **Report and teardown:** bind public result to exact package/image/client/OS/CPU
   and native type scope. Record unknown/manual evidence and cleanup failures; release
   leases only after proved owned cleanup. Never claim ARM/Mac/WSL/native editor,
   production preparation, license compliance or Oracle vendor certification from a
   Linux x64 fixture. No standing instance or paid resource remains.

## Estimate and exit criteria

A report can complete without an artificial runtime run. For a separately approved
initial local SQL-only slice, the provisional estimate is **17–30 engineering
person-days**, including paired Lab work, assuming the reviewed image/client fit the
resource envelope and the reduced privilege/type contract is enforceable:

| Work                                                                                     | Person-days |
| ---------------------------------------------------------------------------------------- | ----------- |
| Exact distribution/client/secret-path review and configuration/capability binding        | 2–4         |
| Native typed baseline, SQL/PLSQL units, snapshot and privacy validation                  | 4–7         |
| Owned container/PDB lifecycle, restricted sessions and partial-state recovery            | 4–7         |
| Genuine independent packed-consumer/Lab positives, denials, cancellation and persistence | 5–8         |
| Engine-neutral editor projection and concise compatibility/documentation                 | 2–4         |

The range excludes license/legal waits, image acquisition, hardware/runner provisioning,
additional OS/CPU qualification, native UI/manual proof and enterprise/hosted features.
It is not authorization, scheduling or a supported feature estimate for all Oracle
editions. If the snapshot/privilege/codec or cancellation assumptions fail, narrow or
reject the slice and re-estimate before implementation, rather than hiding the gap.

**Go:** accept this feasibility/design deliverable and preserve a reproducible future
local route. **Defer:** implementation, downloads, license acceptance, operational
qualification and support announcement until exact scope/consent/resources are
approved. **Reject for the initial slice:** production contact, unfiltered dump
imports, privileged user-schema evaluation, implicit cross-engine conversion,
unreviewed external effects and an unbounded/always-running database.

The outstanding implementation questions are concrete qualification work, not proof
that Oracle is pointless or impossible. No separate viability Inbox entry is warranted
by this source-only report. The owning tracker remains authoritative for priority.
