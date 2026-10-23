# Local resource efficiency and managed execution feasibility

October 23, 2026. Engineering design for [the resource initiative](https://github.com/Ddupasquier/rehearsal-db/issues/208)
and [native-runtime feasibility](https://github.com/Ddupasquier/rehearsal-db/issues/169).
Current user behavior remains owned by [runtime lifecycle](../runtime-lifecycle.md).

## Decision and delivery order

Keep efficient local execution, complete CLI functionality and essential safety free.
Develop optional managed execution as a separate paid-service offering, with prices and
operating commitments dependent on measured costs and commercial review. Deliver the
ready documentation and current Insights acceptance slice first, then finish local
resource reliability through the existing lifecycle owners. Research does not enable
a new runtime, upload data or start a cloud service.

## Resource evidence and the next local corrections

The exact public core 1.1.0 profile runs recorded these short idle container means:

| Profile              | Containers |     Memory |
| -------------------- | ---------: | ---------: |
| PostgreSQL           |          1 |   22.9 MiB |
| Supabase application |          6 |  355.6 MiB |
| Full Supabase        |         13 | 1700.8 MiB |

The approximately 79% application-versus-full difference is not a whole-machine saving
or equivalent service coverage. Cached images, an already-running engine and one macOS
arm64 host limit the comparison. Exact reports and preservation evidence belong to
[#118](https://github.com/Ddupasquier/rehearsal-db/issues/118).

Extend the existing Lab harness to distinguish container usage, host pressure and engine
VM allocation; measure startup peaks and representative bounded load as well as idle.
Use a separate exclusive environment for cold images, VM boot and actual memory release.
Never manufacture cold measurements by pruning shared images or stopping other projects.

Choose further optimizations from those observations. Keep declared service dependencies
and representative failure rows intact. Cross-project admission should delay or refuse
a new heavy run when safe capacity is unknown, using bounded cancellation and ownership
leases rather than killing another workload. Cache reuse must bind exact input bytes,
privacy policy, artifact/runtime versions and immutable baseline identity; corruption,
drift or uncertain ownership must refuse reuse or take a verified full restore path.

## Managed worker design

A control API can authorize and track work, but it is not the database execution sandbox.
Separate the request/control plane, artifact transfer, isolated worker and evidence store.
Keep provider selection open until its actual isolation, lifecycle, networking and costs
fit the workload; an ordinary stateless HTTP function alone does not own a persistent
PostgreSQL or Supabase stack.

The proposed execution request binds tenant and project identity, protocol version,
exact core artifact, baseline and ordered candidate digests, required services, proof
command policy, consent and resource ceilings. Any changed input invalidates that review.
Tenant identity comes from server authorization, never a client-supplied field alone.

Use a separate disposable worker boundary per customer/run. Untrusted migrations and
application proofs must not receive control-plane secrets, a shared host Docker socket
or another tenant's network/storage. Credential scopes and lifetimes must be independent
from baseline content. Network access is denied unless the reviewed scenario requires it;
production access and real provider-account operations are not defaults.

Completion requires both the result and cleanup evidence. The proposed sequence is
queued, leased, running, verifying, cleaning and then completed, failed or cancelled.
A cleanup failure leaves an explicit retained/quarantined resource state with bounded
expiry and recovery; a successful SQL exit cannot mask it. Reuse the existing signed
evidence work in #80 rather than inventing a second signature format.

Local CLI use needs no remote account. Remote uploads require separate consent for the
exact reviewed baseline, migration/proof inputs, destination and retention policy.
Sanitized data can still contain confidential schema or business structure. Limit stored
content and diagnostics, support cancellation/deletion, and distinguish an owner request
from verified physical removal.

## Cost model and prototype acceptance

Do not price an unlimited service from local idle samples. For each proposed provider,
obtain its actual billing units and measure a representative isolated run. Account for
CPU and memory allocation over time, restore/startup, retained storage, transfer, idle
capacity, control-plane operations, failed runs and cleanup. State minimum billing units
and quotas. A per-run cost estimate remains unknown until those rates and durations exist.

The first prototype should use synthetic inputs, no external customer account and no
new paid resource. Prove valid and stale consent, exact digest binding, tenant mismatch,
quota/capacity refusal, cancellation, worker loss, cleanup failure and privacy-safe result
projection. Test the exact installed public interface in Lab. A local protocol simulation
is not proof of real tenant isolation or a functioning hosted service.

The feasibility/protocol slice is roughly 3–5 focused engineering days. A hosted pilot
needs a provider-specific estimate after isolation, budget, legal/support and operational
review; it is not a promise of delivery within that range. #79/#96 own edition boundaries,
#87 the runner deployment options, #85 billing and #141 legal/support terms.

## Supabase native runtime assessment

**Defer switching supported Rehearsal runtimes.** A bounded isolated evaluation is useful,
but current safety checks and the upstream experimental interface are not interchangeable.

Our core verification workflow pins Supabase CLI **2.117.0**. Upstream documents the stack
interface from **2.119.0**; this review pins source observations to the published
[2.121.0 release](https://github.com/supabase/cli/releases/tag/v2.121.0), not an assumed
feature in the existing pin. No CLI was upgraded or runtime started for this assessment.

[Upstream runtime guidance](https://supabase.com/docs/guides/local-development/docker-and-native-runtimes)
limits native execution to Linux amd64/arm64 with the specified glibc requirements and
macOS 14+ on Apple Silicon, excluding native Windows and Intel macOS. It requires service
archive downloads and extraction; checksums protect bytes, not a Rehearsal support claim.
State and a shared archive cache live under Supabase's home, which a future isolated
experiment must redirect into its owned external-volume workspace.

[The stack interface](https://supabase.com/docs/guides/local-development/running-multiple-local-projects)
changes project identity to include root, branch and name; ports, environment output and
stop/discard flags differ from the existing driver. Its compatibility promise excludes
these experimental commands. Automatic native fallback and destruction of old state are
not acceptable migration strategies for Rehearsal.

The proposed experiment explicitly pins `[experimental] stack = true`,
`--runtime native`, `SUPABASE_HOME` and `--output-format json` in its own workspace.
It must not source the user's shell, use a shared home/cache or rely on automatic
backend selection. Even upstream preparation can register local state, so archive
preparation is not a read-only substitute for a separately authorized experiment.

The reviewed [native process owner](https://github.com/supabase/cli/blob/v2.121.0/packages/stack/src/runtime/NativeProcess.ts)
already includes a parent-loss launcher, process-group cleanup and artifact pins. Its
[integrity helper](https://github.com/supabase/cli/blob/v2.121.0/packages/stack/src/preparation/Integrity.ts)
checks SHA-256 and relative paths. These are useful implementation boundaries, not a
passing independent isolation/cleanup test. The [new environment output](https://github.com/supabase/cli/blob/v2.121.0/apps/cli/src/commands/experimental/stack/status/status.env.ts)
also differs from the current driver's `status -o env` contract.

| Rehearsal boundary     | Native evaluation required                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Runtime and ports      | Explicit backend pin, fixed loopback listeners, two unrelated workspaces and no implicit fallback                       |
| Process and files      | Exact process birth/group and owned directories; foreign process/cache sentinels survive stop, cancellation and discard |
| Restore and migrations | Exact baseline, ledger and candidate verification; interrupted restore preserves the prior baseline                     |
| Auth and Storage       | Same synthetic identity, token, RLS and object-byte proofs; hosted OAuth remains separate                               |
| Application and jobs   | Real API/proof behavior and declared dependencies; evaluate the documented native cron transaction limitation           |
| Cleanup and restart    | Data-preserving stop/reopen, explicit owned discard, worker/parent loss and repeated-stop observations                  |

Upstream recommends containers for multiple local projects because native processes
share host facilities. Keep the container runtime as the supported default. A future
native prototype needs a versioned driver contract, an exclusive disposable host or
sandbox, existing memory/port guards, fixed synthetic sentinels and separate cold/cached
resource observations. First evaluate PostgreSQL, then Auth/Storage/application fidelity;
do not use missing services to claim equivalent performance.

The future Lab experiment should reuse its synthetic library-lending fixture, freeze
the core/CLI artifact hashes and record the initial row/object hashes. Use two independently
leased workspace and home roots with foreign file/process sentinels. Exercise exact
restore, deliberate migration failure and correction, native API/identity/object proofs,
stop/reopen persistence, cancellation and parent loss. Independently compare data and
all sentinel identities after each transition, then remove only the owned experiment.
Report process/host memory and cold/cached startup separately from the container baseline.
This plan requires the reviewed native adapter before any installed-package support test;
existing Docker results cannot substitute for it.

Estimate 1–2 weeks for that bounded prototype and independent lifecycle/provider checks,
before a broader OS matrix. Adoption depends on the measured result, not the estimate.
No native-support or resource-saving claim is established by this report.
