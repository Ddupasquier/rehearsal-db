# Owned native PostgreSQL design

This maintainer proposal addresses [RDB-168](https://github.com/Ddupasquier/rehearsal-db/issues/168).
It does not enable a backend, configuration field, installer or support claim.
The [database capability design](database-capabilities.md) owns shared semantics;
this document owns the additional native-server boundary.

**Recommendation:** investigate one explicitly selected, already installed PostgreSQL
17 build on Linux first. Keep execution deferred until whole-flow privilege and
process/filesystem confinement are demonstrated. Do not replace Docker commands
with host commands while retaining the current driver's administrator sessions.
Removing a VM may remove its overhead; no memory saving or safe allocation has
been measured for this proposed backend.

| Navigate      | Sections                                                                                                                                              |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Safety        | [Privilege boundary](#privilege-boundary-before-execution) · [Ownership](#ownership-and-lifecycle)                                                    |
| Integration   | [Existing owners](#existing-owners-and-proposed-contract) · [Baseline and compatibility](#baseline-and-compatibility)                                 |
| Qualification | [Distribution](#distribution-and-platform-scope) · [Independent Lab plan](#independent-lab-plan) · [Sequence](#implementation-sequence-and-decisions) |

## Privilege boundary before execution

An owned directory and random port establish resource identity, not isolation of
the database process from its user's other files or network. PostgreSQL documents
[server-side file/program access](https://www.postgresql.org/docs/17/sql-copy.html)
and [superuser privilege bypass](https://www.postgresql.org/docs/17/role-attributes.html).
The existing container transport executes schema, restore and verification through
its configured database owner. That transport cannot simply become a host process.

Separate three authorities in a native implementation:

1. A fixed bootstrap administrator creates the empty cluster, fixed roles and
   database before project SQL exists. Its secret never reaches migrations, SDKs,
   application children or user-configured hooks.
2. Independently authenticated restricted connections own schema/migration and
   application work. No superuser, role/database creation, replication, bypass-RLS,
   server file/program roles or escalation membership is inherited.
3. Every later restore, policy, verification, metadata and cleanup phase has an
   explicit privilege map. Project-created triggers, expressions, functions and
   security-definer objects must not be invoked later under bootstrap authority.
   Switching roles in an administrator-authenticated session is insufficient.

Restrict server extensions/languages, preload libraries, configuration includes,
external access and project runtime hooks to the separately qualified scope.
Unknown features refuse before cluster mutation. Arbitrary project code does not
become confined because its environment is clean. If a required operation needs
administrator evaluation of project objects, it needs independently proven OS
confinement or remains unsupported. Do not solve that conflict by silently dropping
verification, weakening the trust contract or calling an ordinary host process a
sandbox. This whole-flow question also applies to executable migration adapters;
their owning work remains separate.

## Existing owners and proposed contract

| Responsibility        | Keep                                                              | Narrow addition                                                                                                                                      |
| --------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Target/configuration  | `src/targets/target.mts`, `project/configuration_*.mts`           | PostgreSQL family with explicitly discriminated native/container backend; strict unknown-field refusal                                               |
| Orchestration/consent | `runtime/lifecycle_engine.mts`, topology and input-binding owners | Native operations behind the existing lifecycle; backend identity enters exact consent                                                               |
| Process/SQL transport | shared owned-process/cancellation and target transport            | Absolute reviewed binaries, argument arrays, bounded I/O and independently authenticated role-specific sessions                                      |
| Ownership/recovery    | existing marker/receipt and project lock owners                   | Native cluster creation nonce, canonical directory identity, binary/build digest, OS user, process birth/executable, endpoint and server incarnation |
| Resource coordination | workload admission and queue owners                               | Same user/boot coordination namespace; native tasks consume declared capacity without claiming a hard OS quota                                       |
| Presentation          | negotiated Core capabilities and existing Editor transport        | Explicit native availability/qualification; no second engine manager or migration runner in the extension                                            |

Proposed configuration describes an absolute reviewed binary directory, native
workdir, selected version/build and resource policy. These are design requirements,
not accepted field names or example configuration to paste into today's package.
Do not read `PGDATA`, a default service, `PATH`'s first server, `.pgpass`, startup
files or ambient libpq selectors as authority. Supply a scrubbed environment,
explicit connection parameters and private credential files; disable client startup
configuration. Discovery observes bounded metadata and never starts a cluster.

## Ownership and lifecycle

Create exclusively in a private canonical approved root with held ancestry, no
symlink/hard-link aliases and a nonce-bound receipt. Data, WAL, logs, sockets, temp
and crash/recovery output must remain inside approved storage; no internal-drive
fallback. Existing suite drive placement remains owned by its shared layout, not
this proposal. Reject a pre-existing arbitrary cluster, system service, source
database or listener even when its name, port or owner appears familiar.

Use a short private socket directory where supported and an explicitly leased
numeric loopback TCP endpoint for applications. PostgreSQL's server accepts
explicit [listen/socket/data settings](https://www.postgresql.org/docs/17/app-postgres.html).
Prove the connection reaches the recorded cluster incarnation and database before
each operation; readiness alone is not ownership. Configure SCRAM authentication
and exact local access rules; never inherit `initdb`'s convenient trust default.
[Initialization](https://www.postgresql.org/docs/17/app-initdb.html) must run as the
non-root server owner, with deterministic reviewed encoding/locale and private
bootstrap-password handling.

| Transition      | Required behavior                                                                                                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Create/start    | Hold project and shared admission, validate binaries/paths/config, initialize only a new owned root, start a foreground supervised process and establish birth/endpoint/cluster binding before readiness succeeds                    |
| Stop/start      | Stop only proven owned processes; retain data and generation. A restart checks server/build compatibility and ownership before launch; it does not adopt an unknown live PID                                                         |
| Reset           | Confirm exact current inputs and existing owned target; stage a separately owned replacement, verify it, stop the old target, then publish a recoverable pointer transition. Failure never silently deletes the last retained target |
| Discard         | Confirm the exact receipt-bound cluster; prove all owned server/client descendants and handles closed, then remove only recorded owned data/sidecars. Preserve baselines and unrelated files                                         |
| Cancel/crash    | Bound client and server shutdown separately, preserve uncertain state and report incomplete cleanup. A failed SQL command is not proof of rollback; no success receipt before independent checks                                     |
| Ownership drift | Refuse signalling or deletion on PID reuse, changed executable/data/endpoint/nonce, foreign handles or ambiguous descendants; retain recovery and identify the blocked action                                                        |

Prefer direct supervised `postgres` over daemonizing `pg_ctl start`, so lifecycle
ownership does not disappear into a detached service. Shutdown implementation must
respect PostgreSQL's documented [smart/fast/immediate distinctions](https://www.postgresql.org/docs/17/app-pg-ctl.html):
bounded fast shutdown rolls back active transactions; immediate shutdown implies
crash recovery and cannot be reported as a clean stop. A PID file or successful
`pg_ctl status` is corroboration, not permission to signal that process.
No service registration, login agent, automatic restart or global process kill.

## Baseline and compatibility

Reuse verified PostgreSQL SQL/history and sanitized-row formats only after explicit
compatibility checks; native execution is not physical restoration of a container's
data directory. Bind exact server/client build, encoding, locale/collation,
extensions and role semantics. Refuse required extensions or schema features not
in the selected distribution. Preserve source access and privacy preparation as
separate reviewed operations; never point native reset at the source cluster.

Keep immutable baseline checksums, history prefix and whole-plan approval. Native
receipts must be distinguishable from container receipts so old clients cannot
interpret a native directory as a container or attempt destructive recovery.
Negotiate new capability/persisted variants before activation; no reassignment of
existing baseline format numbers or schema-1 meanings. Package update, server
upgrade and cluster format migration remain separate reviewed actions. No implicit
native/container conversion or fallback; existing PostgreSQL/Supabase paths remain.

## Distribution and platform scope

The first feasibility fixture should consume an explicitly supplied existing binary
set, not install a package manager or bundle a server. Bind `postgres`, `initdb`,
`psql` and every used client/control tool to one qualified build; review dynamic
libraries, shared extension/control files, architecture and executable provenance.
The [PostgreSQL license](https://www.postgresql.org/about/licence/) permits use and
redistribution with its notices; that does not review a vendor's binary bundle or
each included library/extension. Bundled distribution requires its own checksum,
notices, update/support and supply-chain decision before any downloader exists.

Start with one exact Linux x64/local-filesystem tuple. macOS arm64/x64 need their
own process/confinement, library and filesystem evidence. Native Windows stays
blocked on [its safety primitives](https://github.com/users/Ddupasquier/projects/2?pane=issue&itemId=282282739);
neither WSL nor a POSIX fixture establishes that support. No existing system service
may be stopped or repurposed to manufacture a clean result.

Record startup/idle/load/stop RSS for the whole owned process set, CPU, handles,
disk/WAL/temp bytes, readiness and shutdown timings. Proposed connection, buffer,
worker, statement and disk limits require exact qualification. PostgreSQL
[memory settings](https://www.postgresql.org/docs/17/runtime-config-resource.html)
are not a total process-memory cap; cooperative admission is not OS enforcement.
No numerical minimum, comparative saving or default allocation is established here.

## Independent Lab plan

Develop this alongside any authorized prototype in Test Lab, using its public
exact-installed Core package, current leases and storage wrapper. No new automatic
or required CI gate. A small independent two-table fixture has a foreign key,
nullable/unique values, Unicode, binary and large numeric values, plus real SQL
history. A sibling file and separately owned source process are preservation canaries.

| Case                  | Independent assertion                                                                                                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Restore/migrate/proof | Sanitized exact values, constraints/history and approved pending migration match independent queries; application uses only the declared restricted local connection                                                       |
| Privilege and effects | Bootstrap credentials absent from children; restricted sessions cannot access forbidden roles/files/programs; project objects cannot cause privileged later evaluation; confinement denies outside-storage/network effects |
| Persistence/reset     | An intentional sandbox edit survives stop/start; explicit reset restores baseline; original source, generation and sibling canaries survive                                                                                |
| Interruption          | Cancel initialization, restore, migration and proof; server/client descendants close within declared bounds or visibly retain uncertain recovery, with no foreign process signalled                                        |
| Drift/concurrency     | Wrong build, PID reuse, occupied port, stale consent, path alias/swap, lost lock and two writers refuse without adopting or deleting foreign resources                                                                     |
| Cleanup/limits        | Exact-owned successful cluster/processes disappear before lease release; failed cleanup stays failed; disk/temp/output/time pressure preserves evidence and unrelated data                                                 |

Reports bind artifact/build/OS/filesystem identity, input digests, actual limits,
positive and negative results, preservation witnesses and cleanup. Source/unit
tests alone do not qualify native isolation, filesystem semantics or RAM savings.

## Implementation sequence and decisions

1. Review whole-flow SQL privileges and one feasible OS confinement mechanism;
   settle the first binary/build/platform and its distribution terms. If these
   cannot preserve the existing isolation claim, defer execution rather than
   quietly offering a weaker automatic fallback.
2. Prove native ownership, restricted session boundaries and bounded shutdown in
   a separately authorized synthetic prototype with paired Lab assertions.
3. Implement negotiated configuration/receipts and transport through existing
   owners, then complete lifecycle, baseline and failure/recovery acceptance.
4. Independently qualify each additional platform before advertising it; keep
   container and unsupported-version behavior explicit throughout.

Provisional engineering estimate: 3–5 person-days for the privilege/confinement
feasibility, then 8–14 for one complete qualified Linux slice and paired Lab;
distribution and each additional platform are separate estimates. These are not
deadlines or operational approval. Unresolved confinement, build selection,
resource measurements and Windows primitives remain implementation prerequisites.
