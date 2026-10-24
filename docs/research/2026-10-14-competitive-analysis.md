# Competitive review: two products named Rehearsal

Date: October 14, 2026. Scope: issue #150, investigation and recommendations only.

## Recommendation

Keep Rehearsal DB focused on **rehearsing the whole application against a reviewed,
sanitized local database copy**, not winning a checklist contest against a SQL editor.
The competing project has substantial implementation, including copy-based measurement;
describing it as merely a SQL linter would be inaccurate. Our differentiation must be a
demonstrable workflow and trust boundary, not the word “copy.”

Before new paid-launch commitments, resolve the naming/distribution questions, show one
ordinary developer a migration failure that an empty database misses, and measure whether
the complete setup is worth repeating. Do not rebrand, change licenses, build paywalls,
or rewrite the launch roadmap on the strength of this report alone.

## Evidence and limits

Competitor source was inspected at
[`e5bea7c1a5f580f95a8f44cadb9d30991f272a06`](https://github.com/azyzex/Rehearsal/tree/e5bea7c1a5f580f95a8f44cadb9d30991f272a06),
whose commit timestamp is September 28, 2026, 12:39:18 UTC. The public repository API,
124 reachable commit summaries, complete non-truncated tree, selected source/tests, and
documentation were read. No competitor code, installer, tests, application, or database
was executed. Source inspection establishes implementation paths, not passing runtime
tests, production safety, customer adoption, or release quality.

The Rehearsal DB column below summarizes maintained local contracts, not an assertion that
every working-tree feature is published. Its source repositories may require maintainer
access; relative links are not evidence that a public customer can inspect them. Release
claims must be checked separately against the actual npm/VSIX artifacts and their exact
acceptance evidence. Private operational inventories do not belong in this report.

## Dated evolution

These are Git commit timestamps and source changes, not invention, trademark-priority,
or copying conclusions.

| Date (UTC)   | Verified history evidence                                                                                                                                                                                                                                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| August 19    | Repository created; [initial scaffold](https://github.com/azyzex/Rehearsal/commit/3fb116d70cc1e5b2283e12f469ab8077827cd335) has package/display name **Dry Run**, a PostgreSQL adapter, and rollback-focused tests.                                                                                                                                                      |
| August 19    | [Statement analysis and panel](https://github.com/azyzex/Rehearsal/commit/8b6fa5ee50a10f55c5e68f0eba7f00d637c3acc9); a [local PostgreSQL testbed](https://github.com/azyzex/Rehearsal/commit/bb40a1f73b813d675a55ae4ec72a60c115624b01) follows.                                                                                                                          |
| August 22–24 | [Schema explorer](https://github.com/azyzex/Rehearsal/commit/e1f28db9bf7d25278b22f37c7040cb5e3fbb50b9), [guarded editing/apply](https://github.com/azyzex/Rehearsal/commit/4dfc23d28212264787bb27b9cfca99ed16dfefab), and [destructive-change rescue capture](https://github.com/azyzex/Rehearsal/commit/c1992edf67b0d29d48948050692ed5ef88baaeb0) appear.               |
| August 25    | [Headless analysis](https://github.com/azyzex/Rehearsal/commit/ca152def7cf25a44ac1810fe9e954c01483d3390), [MySQL](https://github.com/azyzex/Rehearsal/commit/e53144d2b3a528d8c228350da167ad4ae12c303b), and [MongoDB](https://github.com/azyzex/Rehearsal/commit/46169324b755c3e9809afaf092800f2fa56a958c) enter the history.                                            |
| August 27    | [MySQL copy-based DDL measurement](https://github.com/azyzex/Rehearsal/commit/945dc4d26b683b6e9cd00a472ff6bd0a995cfa8a) and [SQLite implementation](https://github.com/azyzex/Rehearsal/commit/c58a161b3dc36979c20a69ffabd032637de6692d).                                                                                                                                |
| September 27 | [Explicit rename from Dry Run to Rehearsal](https://github.com/azyzex/Rehearsal/commit/e28a00258fa04bbc2e55f89228c40a7393dc90a8); the August repository creation date is not evidence of using the current name since August.                                                                                                                                            |
| September 27 | [Credential-free SQLite sample](https://github.com/azyzex/Rehearsal/commit/2b74f90f75f15b506d8429d71e26f526c32a56ec), [PostgreSQL scratch-copy rehearsal](https://github.com/azyzex/Rehearsal/commit/c144fe13d739412103423930fc8a3846b364b40e), and [before/after query-plan work](https://github.com/azyzex/Rehearsal/commit/a659a477829f1a4c45b84098cd01a363b527ba8f). |
| September 28 | Pinned HEAD adjusts package exclusions. Current tags/releases API responses contain no entries; this does not prove that no artifact has ever existed elsewhere.                                                                                                                                                                                                         |

The pinned [README](https://github.com/azyzex/Rehearsal/blob/e5bea7c1a5f580f95a8f44cadb9d30991f272a06/README.md#L9-L12)
describes the product as not yet published, but that statement is stale: the
[public Marketplace listing](https://marketplace.visualstudio.com/items?itemName=azizguenni.rehearsal)
exists. Independent read-only Marketplace metadata inspection found public, validated
version `0.1.0`, first published September 28, 2026, 12:47:03.957 UTC, and its VSIX
download endpoint returned HTTP 200. The package was not executed. Public availability is
therefore verified; install counters are not evidence of repeated use or willingness to
pay. No tag/release entries on GitHub does not mean the extension is unpublished.

The September rename is specifically the extension/package-facing rename. Its commit
message says the repository itself was already called Rehearsal; that statement does
not independently establish when that repository name first became public. Do not
turn the extension's old name into a claim about either party's legal priority.

Its manifest declares publisher `azizguenni`, package `rehearsal`, and `private: true`;
the npm-private flag does not prevent Marketplace distribution. The
[publishing guide](https://github.com/azyzex/Rehearsal/blob/e5bea7c1a5f580f95a8f44cadb9d30991f272a06/PUBLISHING.md)
describes a free MIT product. No price or revenue is established here.

### Our independently dated history

These are maintainer-access Git commits plus public npm dates: recorded evolution,
not invention dates, trademark priority or copying evidence. History before this
repository was not reconstructed.

| Date (UTC)      | Rehearsal DB evidence                                                                                                                                                                                                                                                                                |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| September 14–15 | Initial commit `dd06736b40774c18e53c490d23dd682bd66b3651`; reusable runtime extraction `e51732d8474b78199eb5d81216e8eadd817fcd2c`. First actual npm publication beta.1: September 15, 05:13:16 UTC. beta.0 was not published to npm.                                                                 |
| October 2       | PostgreSQL driver `ba1bc02bdeb62bfb79dc994f001f4b4c98958608`; guided onboarding, support and cleanup developed across early October releases.                                                                                                                                                        |
| October 3–4     | Standalone multi-target `df7b49a311f06c4443948902bb0f8f79eea12a54`, persistent sessions `2b05e31021883f4473eeb572ee1614e29b84b927`, root config `a279c82da37dc6eef1e7a1d5ed34e09f139d8886`, declarative Auth `023b13217b296b2f1b4291a22abe1c0bd1dfb011`. Commit dates differ from publication dates. |
| October 5–9     | beta.13 published October 5, 08:04:54 UTC. Privacy/source preparation, TypeScript conversion and typed pipelines reached beta.14–18; beta.15 is the first inspected tarball generation with broad generated declarations. First RC published October 9, 18:16:37 UTC.                                |
| October 10–12   | Extension prototype `f49793da3ab4a301cba1da96bcb40b05684dfa1a`, workbench `7100eda09540a0560d7e545b8c9a83caf00a7ad8`, dashboard `440a6e6a1994f5cb5ee61c8f1de475139cc1ff83`. GitHub release assets exist for 0.1.1/0.1.2; a release does not prove anonymous distribution or Marketplace publication. |
| October 11–14   | Public core rc.4 published October 11, 23:20:35 UTC. October 14's enhancement candidate is different, uncommitted and unpublished; reused version metadata is not a new release.                                                                                                                     |

### Obtainable releases versus development

On October 14 the [public registry](https://registry.npmjs.org/@rehearsal-db%2fcore)
has 22 versions, all MIT; `latest` and `beta` both resolve to rc.4. Its
[actual tarball](https://registry.npmjs.org/@rehearsal-db/core/-/core-0.1.0-rc.4.tgz)
has SHA-256 `468fa219769ec7d0d902a4ce6aed7c8a66087005993f3ba4de39a5179634ba5a`,
238 files and 103 readable JavaScript modules. Registry integrity matched. A temporary
consumer installed it with scripts disabled and ran installed `--version --json` and
`--help` successfully. These are not database acceptance tests.

| Status                      | Verified scope and boundary                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Published CLI rc.4          | Immutable sanitized baselines, reviewed source preparation, PostgreSQL/Supabase targets, exact candidate/history verification, identity/Storage association, application proofs, persistent session, conservative lifecycle/cleanup and Project Profile. Source commit `1a3d99767c0e0bb12e49b9f616555d650ce11e92` matches the public provenance payload. No claim that real-provider flows ran during this research. |
| Private core candidate H    | SHA-256 `2700b61cf602affaa728bbbb6fa7464d374051dbaa3af57dda27a3980e1e6c8f`: resources, configuration/migration review, baseline shaping, progress, profiles and foreground idle policy. 326 files/six declared editor contracts versus only Project Discovery in public rc.4. Existing exact H gate reports nine scenarios passed; live fixtures were not rerun here.                                                |
| Private extension candidate | SHA-256 `226c3f4cb49804c1c4b8b204809db2efb2ada76a7f73a0d65f075cc2e0638651`, 0.1.2 metadata. Workbench and explicitly approved CLI actions—not merely the original read-only prototype. Different bytes from the GitHub 0.1.2 release. The current manifest's exact `rehearsal-db.rehearsal` Marketplace URL returned 404; this does not prove no other listing exists.                                               |
| Commercial proposal         | Manual evaluation/order terms and packaging checks exist. Payment, activation, entitlement enforcement, account service, telemetry and public Marketplace distribution are not implemented/approved merely by commercial documents. The $49 founding offer is an unvalidated hypothesis, not established pricing/revenue.                                                                                            |
| Deferred/unsupported        | MySQL/MongoDB/SQLite targets, automatic SQL safety/verdict/lock predictions, signed commercial evidence and supported customer CI service. Current migration review explicitly does not infer SQL-body safety.                                                                                                                                                                                                       |

Current code is not automatically shipped; a release is not automatically reachable;
a green package gate is not paid demand. Availability and publication safeguards
require #153's separate private review; its account/security inventory is omitted here.

## Architecture and feature comparison

“Present” means source inspected unless a row explicitly says documentation-only.

| Area                           | azyzex/Rehearsal                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Rehearsal DB contract and product implication                                                                                                                                                                                      |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Main workflow                  | Connect an editor or headless analyzer to a chosen database; inspect statements and optionally edit/apply. [Connection manager](https://github.com/azyzex/Rehearsal/blob/e5bea7c1a5f580f95a8f44cadb9d30991f272a06/src/connection/manager.ts#L133-L175).                                                                                                                                                                                                                                       | Prepare a verified baseline, restore an isolated local runtime, apply the exact approved migration suffix, and run ordinary application proofs. [Architecture](../architecture.md). Different primary job, meaningful overlap.     |
| Engines                        | Concrete PostgreSQL, MySQL, MongoDB, and SQLite adapters. Capabilities differ; MongoDB requires transactions, SQLite needs Node's SQLite module, MySQL cannot roll back DDL. [Selector](https://github.com/azyzex/Rehearsal/blob/e5bea7c1a5f580f95a8f44cadb9d30991f272a06/src/adapters/select.ts).                                                                                                                                                                                            | PostgreSQL and Supabase targets; broader engine coverage is not an approved current promise. Depth of the application/Storage/Auth workflow matters more than engine count.                                                        |
| Statement impact               | Actual rolled-back DML, bounded before/after samples, DDL data probes, lock estimates, plans, cascades and offender inspection. [DML](https://github.com/azyzex/Rehearsal/blob/e5bea7c1a5f580f95a8f44cadb9d30991f272a06/src/analysis/dml.ts), [DDL](https://github.com/azyzex/Rehearsal/blob/e5bea7c1a5f580f95a8f44cadb9d30991f272a06/src/analysis/ddl.ts).                                                                                                                                   | Real migration/application outcomes, rather than a claimed equivalent statement-cost advisor. Do not advertise parity that has not been implemented and accepted.                                                                  |
| PostgreSQL copy mode           | Copies touched tables and their indexes/constraints into a schema inside the connected database, changes `search_path`, measures allowed statements, then rolls back. Foreign keys are explicitly absent. [Implementation](https://github.com/azyzex/Rehearsal/blob/e5bea7c1a5f580f95a8f44cadb9d30991f272a06/src/adapters/postgresRehearsal.ts#L106-L225).                                                                                                                                    | A separately owned disposable runtime plus immutable baseline is a different isolation and repeatability boundary. Do not claim exclusive ownership of copy-based rehearsal.                                                       |
| MySQL copy mode                | Optional persistent table clones, default 500,000-row ceiling, cleanup in `finally`, and a stale-prefix sweep. Foreign keys are absent. [Implementation](https://github.com/azyzex/Rehearsal/blob/e5bea7c1a5f580f95a8f44cadb9d30991f272a06/src/adapters/mysqlClone.ts).                                                                                                                                                                                                                       | Unsupported engine; do not add it merely to match a comparison table. Reusable ownership and cleanup guarantees must precede another engine.                                                                                       |
| Privacy and source preparation | Inspected connection path reads declared settings, environment or `.env`; saved credentials use VS Code SecretStorage. This is not evidence of an exhaustive sanitization, immutable-baseline, or reviewed source-reader workflow. [Resolution](https://github.com/azyzex/Rehearsal/blob/e5bea7c1a5f580f95a8f44cadb9d30991f272a06/src/connection/resolve.ts), [saved connections](https://github.com/azyzex/Rehearsal/blob/e5bea7c1a5f580f95a8f44cadb9d30991f272a06/src/connection/saved.ts). | Reviewed source scope, strict privacy policies, local pseudonym keys, checksums, and target-bound evidence are central. [Security model](../security-model.md). These need observable acceptance, not “safe data” marketing alone. |
| Application fidelity           | Database-centric probes and schema/edit tools; no full Supabase Auth/Storage plus application orchestration contract identified in the inspected paths.                                                                                                                                                                                                                                                                                                                                       | Application launch/proofs and local identity/Storage behavior are part of the maintained runtime workflow. This is the strongest practical demonstration opportunity.                                                              |
| Approval boundary              | Preview fingerprint and explicit destructive confirmation; apply delegates to a dedicated commit module. The fingerprint is expressly non-cryptographic. [Apply](https://github.com/azyzex/Rehearsal/blob/e5bea7c1a5f580f95a8f44cadb9d30991f272a06/src/edit/apply.ts#L59-L126).                                                                                                                                                                                                               | Exact candidate bytes/digests, baseline/history checks, project locks and owned target identity. Describe the difference without implying that a digest establishes business correctness.                                          |
| Editor onboarding              | A built-in SQLite sample and walkthrough can demonstrate value without credentials or Docker. [Sample](https://github.com/azyzex/Rehearsal/blob/e5bea7c1a5f580f95a8f44cadb9d30991f272a06/src/sample/sampleDatabase.ts).                                                                                                                                                                                                                                                                       | Our fuller baseline/runtime setup has more prerequisites. Measure activation friction and explain why those prerequisites buy useful fidelity.                                                                                     |
| CI                             | Headless CLI and a consumer GitHub Action example with report/severity handling. [CLI](https://github.com/azyzex/Rehearsal/blob/e5bea7c1a5f580f95a8f44cadb9d30991f272a06/src/cli/index.ts), [example](https://github.com/azyzex/Rehearsal/blob/e5bea7c1a5f580f95a8f44cadb9d30991f272a06/examples/rehearsal.yml). No maintained `.github/workflows` files appear in the pinned tree.                                                                                                           | Separate internal release acceptance from a supported customer CI product. An internal green build does not complete customer CI or signed-evidence work.                                                                          |

## Safety findings: narrower than a certification

- **Rollback safeguards are implemented, not merely promised.** PostgreSQL serializes
  operations, rejects parsed transaction control, sets timeout ceilings, and rolls back
  in `finally`. Tests contain independent-connection checks after success, failure, and
  timeout. [Adapter](https://github.com/azyzex/Rehearsal/blob/e5bea7c1a5f580f95a8f44cadb9d30991f272a06/src/adapters/postgres.ts#L114-L165),
  [test source](https://github.com/azyzex/Rehearsal/blob/e5bea7c1a5f580f95a8f44cadb9d30991f272a06/src/test/rollback.test.ts).
  Those tests were not run during this review.
- **Connected-database analysis is not physical isolation.** The editor's production
  check uses configurable identity patterns and an allowlist, not a loopback-only target
  proof. The headless CLI connects directly through its adapter; the reviewed CLI path
  does not call the editor's pattern guard. [Guard](https://github.com/azyzex/Rehearsal/blob/e5bea7c1a5f580f95a8f44cadb9d30991f272a06/src/connection/guard.ts#L78-L111),
  [CLI connection](https://github.com/azyzex/Rehearsal/blob/e5bea7c1a5f580f95a8f44cadb9d30991f272a06/src/cli/index.ts#L94-L107).
  Neither implementation should be evaluated using the other's safety promise.
- **Copy fidelity has stated limits.** PostgreSQL planning skips transaction control,
  `CONCURRENTLY`, and recognized schema-qualified references. The scratch copy omits
  foreign keys and real concurrent traffic; timings do not prove production contention
  or complete application behavior. [Planner](https://github.com/azyzex/Rehearsal/blob/e5bea7c1a5f580f95a8f44cadb9d30991f272a06/src/analysis/rehearse.ts#L19-L77),
  [report limitations](https://github.com/azyzex/Rehearsal/blob/e5bea7c1a5f580f95a8f44cadb9d30991f272a06/src/analysis/rehearse.ts#L200-L218).
- **Rollback does not mean zero effects.** PostgreSQL sequence allocation is not undone
  by transaction aborts. External functions and connected services also need their own
  containment analysis. Conversely, ordinary PostgreSQL `NOTIFY` is delivered only on
  commit; the competitor's notification-warning prose must not be repeated as a proven
  escaping side effect. [PostgreSQL sequence semantics](https://www.postgresql.org/docs/17/functions-sequence.html),
  [NOTIFY semantics](https://www.postgresql.org/docs/17/sql-notify.html).
- **Cleanup models differ.** The MySQL sweep relies on reserved names and age; unknown
  creation time is treated as eligible rather than establishing active-operation
  ownership. Its deletion errors are swallowed. This is a source-observed boundary,
  not a reproduced deletion incident. [Sweep](https://github.com/azyzex/Rehearsal/blob/e5bea7c1a5f580f95a8f44cadb9d30991f272a06/src/adapters/mysqlClone.ts#L222-L262).
- **Documents do not all describe the current same thing.** The roadmap's PostgreSQL
  template-database proposal is superseded by scratch-schema code; the README's generic
  no-DDL-execution safety sentence is narrower in practice because copy/SQLite paths do
  execute DDL. Prefer the pinned implementation and per-engine limits over a headline.

## What the tests and distribution do—and do not—establish

The repository contains real-engine fixtures and integration test source for all four
engines, rollback controls, copy cleanup, transactions, parser cases, and browser-rendered
panels. The README claims 1,235 passing tests. This review did not rerun them or establish
an independently reproducible release. PostgreSQL fixtures use downloaded embedded server
binaries; “no Docker required” is not “no runtime/download/resource requirement.”
[Fixture](https://github.com/azyzex/Rehearsal/blob/e5bea7c1a5f580f95a8f44cadb9d30991f272a06/src/test/support/pgFixture.ts#L7-L16).

The browser harness uses host-message and theme stand-ins. Its own manual guide leaves
real Extension Host integration, dialogs, keyboard use, and perceived usability to human
checks. This is a useful distinction to preserve in our own evidence, too.
[Harness](https://github.com/azyzex/Rehearsal/blob/e5bea7c1a5f580f95a8f44cadb9d30991f272a06/src/test/support/uiHarness.ts#L7-L30),
[manual-check boundary](https://github.com/azyzex/Rehearsal/blob/e5bea7c1a5f580f95a8f44cadb9d30991f272a06/MANUAL-CHECK.md#L11-L25).

## Product decisions proposed, not approved

The overlap is real: both names promise confidence before a database change, both have an
editor surface, and both can exercise changes on copies. The competitor is particularly
strong on immediate per-statement explanations and low-friction sample activation.
Rehearsal DB's candidate audience is developers who need the **application**, not only a
SQL statement, to work against privacy-reviewed representative history. Supabase's
database/Auth/Storage interactions make that distinction concrete.

The defensible asset is accumulated trustworthy restoration, privacy, application, and
recovery evidence—not a feature name, database count, source visibility, or assumed lack
of competing implementation. Customer willingness to pay, repeated independent use,
support cost, and differentiation durability remain unproven here.

### Naming and discoverability

Both products use the same word for related workflows; the competitor's live listing
is `azizguenni.rehearsal`. Our npm scope `@rehearsal-db/core` distinguishes an identifier,
not necessarily a search result or a name remembered after a demo. Recommend the full
**Rehearsal DB** descriptor while evaluating the brand—not automatic edits, a domain
purchase or package rename.

GitHub dates and a rename do not settle legal rights. Before a paid public launch,
seek appropriate professional clearance for related software names, existing use,
relevant countries, domains and marketplace identifiers. No trademark clearance,
legal opinion or infringement determination was performed here. The
[USPTO clearance guide](https://www.uspto.gov/trademarks/search/comprehensive-clearance-search-similar-trademarks)
explains why a federal database query is not the entire search.

### Next milestones and measurable gates

1. **Trustworthy access and delivery:** reconcile #153, prove anonymous docs/support/
   installation and an enforceable reviewed-artifact publisher. No account, visibility,
   release or license change is authorized here. Gates paid launch, not ordinary fixes.
2. **One repeatable application-level win:** the proposed empty/populated demo below
   must record exact migration/digest, empty positive, populated failure and useful
   diagnosis, correction/application proof, resource preservation and cleanup. This
   is not already passed. Observe an unfamiliar developer when available; owner or
   automated runs cannot substitute for that observation.
3. **Smallest distribution/edition experiment:** #151/#152 decide the existing
   paid-preview-first hypothesis versus proposed free Marketplace route. Agree the
   free/paid boundary, cohort, support/refund terms and success measures first. Measure
   first success, repeat use, volunteered willingness to pay and support burden with
   explicit consent; do not invent conversion targets or silently add telemetry.

No new engine, billing backend, schema designer or migration-analysis suite is needed
before these gates. Prove the complete workflow rather than pursue feature parity.

| Decision         | Proposal and existing owner                                                                                                                                                                                                                                                                                                                                                                                       | Rough effort / milestone impact                                                                                                |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Keep — P0**    | Core-owned public contracts, strict local runtime boundaries, useful free safety, exact review and independent Test Lab acceptance. Preserve the existing extension/core split.                                                                                                                                                                                                                                   | Ongoing invariant; no new feature required.                                                                                    |
| **Improve — P0** | Feed verified name/identifier and discovery evidence into #79/#150 and the #151–153 decision memos. Obtain appropriate professional advice before a branding or licensing commitment.                                                                                                                                                                                                                             | Engineering evidence: 1–2 focused days; owner/legal time unknown. Gates new public/commercial commitments, not ordinary fixes. |
| **Improve — P1** | Through #95/#96/#88, package one short end-to-end example: a `SET NOT NULL` migration succeeds on an empty control but fails on representative local data containing a known null; show the exact reviewed migration, useful failure, preserved source/baseline, correction, successful application proof, and cleanup. Existing invalid-SQL/already-existing-column fixtures are not this differentiating proof. | 1–3 days using existing Lab mechanisms; new run evidence required before advertising the example.                              |
| **Improve — P1** | Measure credential-free sample → real-project setup → repeat rehearsal. Record prerequisite count, elapsed time, recovery friction and volunteered value; do not silently enable telemetry. Coordinate the proposed route through #152 rather than prematurely publishing a listing.                                                                                                                              | 1–3 engineering days plus actual observations; launch evidence, not a new engine.                                              |
| **Defer — P2**   | Statement-level lock/index/cost advice, more database engines, and a general visual schema editor until observed users identify a repeatable gap in the core workflow.                                                                                                                                                                                                                                            | Estimate only after a bounded proposal; not MVP scope by default.                                                              |
| **Reject**       | Feature parity as strategy; “only copy-based tool” claims; treating rollback as complete isolation; arbitrary production connections for convenience; source obfuscation as an IP guarantee; accusations from names/dates.                                                                                                                                                                                        | No implementation.                                                                                                             |

Do not create duplicate execution tickets from this table automatically. Present exact
proposed amendments and dependencies to the owner first. Existing #79/#95/#96/#105 and
#141–145 remain unchanged until that decision. No Marketplace, license, visibility,
publication, or commercial-authority change is granted by this research.

## Reproduction appendix

Read-only commands used, with GitHub CLI authentication kept out of output:

```bash
gh api repos/azyzex/Rehearsal
gh api repos/azyzex/Rehearsal/commits/main
gh api 'repos/azyzex/Rehearsal/commits?sha=main&per_page=100&page=1'
gh api 'repos/azyzex/Rehearsal/commits?sha=main&per_page=100&page=2'
gh api 'repos/azyzex/Rehearsal/git/trees/e5bea7c1a5f580f95a8f44cadb9d30991f272a06?recursive=1'
gh api 'repos/azyzex/Rehearsal/tags?per_page=100'
gh api 'repos/azyzex/Rehearsal/releases?per_page=30'
gh api repos/azyzex/Rehearsal/commits/e28a00258fa04bbc2e55f89228c40a7393dc90a8
gh api 'repos/azyzex/Rehearsal/contents/src/adapters/postgresRehearsal.ts?ref=e5bea7c1a5f580f95a8f44cadb9d30991f272a06' \
  --header 'Accept: application/vnd.github.raw+json'
```

Marketplace evidence uses its public item page, the read-only extension-query API with
exact extension filter type `7` / `azizguenni.rehearsal`, and GET
`https://marketplace.visualstudio.com/_apis/public/gallery/publishers/azizguenni/vsextensions/rehearsal/0.1.0/vspackage`.
An API POST carrying a read-only query is not a publication action. No publisher account,
license acceptance, install, or authentication flow was created or modified.

Our chronology used `git log --reverse --format='%H %ad %s' --date=iso-strict` on
relevant manifest/README/architecture and extension history, plus anonymous npm
packument `time`, `versions` and `dist-tags`. All 22 public tarballs' registry integrity
matched. CLI checks used Node 24.21.0/npm 11.19.0 and `--ignore-scripts --no-save
--package-lock=false --no-audit --no-fund`. `npm audit signatures` verified 20 package
signatures and three attestations. No database, application, Docker or Supabase runtime
was started; no additional consumer check or paid service was needed for research.

The same pinned content endpoint was used for the manifest, source/test files, build and
CI example, README, specification, roadmap, publishing guide, and manual-check guide linked
above. Historical manifest inspection confirmed `dryrun` / `Dry Run` at the initial
commit. Third-party claims were not tested by launching their tooling. This report is the
stop-and-report checkpoint, not a release or security certification.
