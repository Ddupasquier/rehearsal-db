# Container runtime lifecycle

Rehearsal uses a local Docker-compatible engine for disposable PostgreSQL and Supabase
targets. It owns the targets it creates; it does not own the shared engine or another
project's containers.

## Machine-aware engine selection

Rehearsal detects the host platform and local Docker context options before
container-backed work. Docker-compatible behavior is the portable foundation;
Colima and OrbStack are optional platform-specific choices. Native Windows runtime
limitations remain in force; detecting an engine does not establish native support.

`rehearsal discover --json`, setup previews and `doctor` share the versioned
`containerEngines` result. It distinguishes tool presence, configured local context
names, selected-daemon reachability and unsupported hosts. Tool/context names are
hints, not vendor conformance. Each vendor still needs exact version/platform
acceptance; an answered probe alone does not certify it. Only the selected local
daemon is probed, with bounded commands. Detection never installs or starts an
engine, switches the global Docker context, imports databases, or infers RAM savings.

An explicit `DOCKER_CONTEXT` takes precedence over `DOCKER_HOST` and the default
context. A scoped `DOCKER_CONFIG` directory is preserved. A direct local host must
map uniquely to a real named context; ambiguous, unmapped, remote and TLS selections
refuse without fallback. Local runtime children receive the reviewed context and
endpoint identity rather than following later ambient context changes. Existing
daemon/receipt checks remain in force at resource mutation boundaries.

When the chosen engine is unavailable, select or start it explicitly and rerun
`doctor`. Rehearsal does not choose another engine merely because it responds:
retained volumes and ownership receipts belong to their original engine. Switching
requires a separately reviewed data migration. Capacity admission is a separate
check and refuses unavailable metrics; discovery is not a memory reservation.
Existing opt-in Colima startup and owned-boot shutdown retain their narrower contract.

## Engine conformance status

Detection and qualification are separate. The following matrix records the current
qualification boundary, not a recommendation to install or switch engines.
[RDB-167](https://github.com/Ddupasquier/rehearsal-db/issues/167) remains open for
vendor/version acceptance. Generic Docker API compatibility is not a tested vendor
version, rootless mode or complete Supabase result.

| Engine / host                                           | Current evidence boundary                                                                                                  | Remaining qualification                                                                                                                           |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Colima 0.10.3 / macOS Apple Silicon, VZ                 | Tested explicit shutdown backend under its documented ownership/process/disk requirements                                  | Other Colima versions, architectures and backends need their own exact observations; shutdown proof alone does not qualify every database/profile |
| Docker Engine / Linux                                   | Portable Docker-compatible runtime path; existing Linux fixture evidence applies only to its recorded artifacts and daemon | Publish an exact vendor/OS/CPU/CLI/API/rootless tuple before claiming broader vendor conformance                                                  |
| Docker Desktop / macOS or Windows-hosted engine         | Experimental vendor qualification; context detection is not an installed-vendor pass                                       | Matched database/service, persistence, refusal, cleanup and resource evidence; native Windows execution retains its current refusal               |
| Podman Docker compatibility / Linux or local VM         | Experimental; a Docker-compatible endpoint does not establish API/lifecycle parity                                         | Exact compatibility-service/CLI/API/rootless tuple, volume/network/ownership and database evidence                                                |
| Rancher Desktop / supported local hosts                 | Experimental vendor qualification                                                                                          | Exact Docker-compatible mode and local endpoint, versions, architecture, data-preservation and service evidence                                   |
| OrbStack / macOS                                        | Optional, experimental vendor qualification; no product default or qualified shutdown adapter                              | Separately approved exact-version fixture and exclusive-engine resource comparison                                                                |
| Remote/TLS/ambiguous contexts; unsupported native hosts | Unsupported for the current local runtime boundary                                                                         | No automatic fallback, remote probing or adoption of unowned resources                                                                            |

Here **tested** means only the explicitly named operation and evidence tuple;
**experimental** means qualification is incomplete, not permission to bypass a
refusal; **unavailable** describes an absent/stopped tool or missing evidence on a
particular machine; **unsupported** is an enforced product boundary. A missing
measurement is unavailable, never zero. These labels do not change runtime behavior
or promise vendor certification.

### Proposed qualification record

For future separately authorized trials, Test Lab should retain one versioned
record per exact tuple: Core artifact SHA-256; scenario/source revision; host OS,
kernel, CPU/virtualization and Node; vendor/product and CLI/server/API versions;
rootless/rootful and compatibility mode; local endpoint kind and private binding
identity; image digest/architecture; provider/service profile and fixture digest;
actual limits; scenario results, report hashes and cleanup outcome. Keep raw local
paths, daemon identifiers, credentials and database rows private. Public summaries
use reviewed aliases and hashes. Unknown fields remain explicit.

Qualify PostgreSQL and applicable Supabase profiles independently, using the same
public installed artifact and maintained ownership/lease guards. A trial must prove
local endpoint binding and changed/remote/ambiguous refusal, exact container/network/
port/volume ownership, migration success and partial failure, stop/start persistence,
interruption/timeouts, concurrent/unrelated preservation and reviewed cleanup. Bind
stopped-container image references as well as running ones. Inspection must never
start the engine. Engine shutdown needs its own explicit current-boot ownership
adapter; database-target cleanup does not grant engine ownership.

Record cold download/VM boot, warm restore, steady-state workload and post-cleanup
host memory separately. Compare matched repeated workloads and actual limits;
container RSS, VM capacity and host pressure are different observations. Promotion
of a matrix cell requires reviewed exact evidence, documented gaps and normal owner
approval for any support expansion. This protocol adds no CI gate, runtime installer,
background collector or automatic vendor selection. The independent procedure is
owned by the [Lab runbook](https://github.com/Ddupasquier/rehearsal-test-lab/blob/main/docs/runbook.md#vendor-conformance-record-proposal).

## What starts Docker?

Read-only commands such as `doctor`, `status`, `candidates`, `explain`, and `inspect` do
not start Docker. Commands that create or resume a database—such as `start`, `reset`,
`run`, and `open`—need an already-running engine.

Generated configurations keep startup explicit:

```js
containerRuntime: {
  autoStartColima: false,
  stopOwnedColimaWhenIdle: false,
  diskWarningPercent: 80,
  minimumFreeBytes: 8589934592,
},
```

With the default, a stopped engine produces an actionable error. Start Docker Desktop,
Colima, Rancher Desktop, Podman with Docker compatibility, or another supported engine,
then repeat the command.

Setting `autoStartColima: true` is an explicit convenience opt-in. If Docker is
unavailable and the `colima` command exists, Rehearsal runs plain `colima start` and
reports it. Rehearsal does not resize Colima. Engine shutdown remains off unless the
separate ownership-guarded policy below is explicitly enabled. Starting Docker can also wake unrelated containers that use Docker's
`always` or `unless-stopped` restart policy. Rehearsal changes only the selected
Supabase stack to Docker's `no` restart policy after it starts successfully.

Auto-start requires the local `colima` context and a stopped default Colima profile.
A failed Docker probe alone does not prove the VM is stopped. If Colima is already
running but Docker is temporarily unavailable, Rehearsal will not start it again or
claim a manually started boot. Select the intended local context and diagnose the engine
explicitly. Runtime managers bind their Docker/Supabase children to the verified local
endpoint; inherited hosted Docker settings cannot redirect them.
Parent/child manager calls also bind the normalized reviewed configuration digest.
Changing a target's settings mid-operation refuses the next action and leaves its
resources intact; review the current configuration and status before retrying.
Ordinary Supabase stopping rechecks container ownership and the runtime workdir's
project ID before delegating to the provider CLI.

To release memory automatically without taking ownership of a shared engine, opt in to
both settings:

```js
containerRuntime: {
  autoStartColima: true,
  stopOwnedColimaWhenIdle: true,
}
```

Rehearsal records a mode-`0600` project-local receipt only when it actually runs a
successful `colima start`. The receipt is bound to the project, target ID, operation, and
the local Docker endpoint and VM's current Linux boot ID. After `stop` or `discard`, Rehearsal requires every target
to opt in, a matching current receipt, and zero running containers across the shared
engine before running `colima stop`. Otherwise it preserves Colima and explains why.
Repeated stop is safe, manually started engines have no receipt, and restarting Colima
invalidates the previous boot receipt. This policy never applies to Docker Desktop,
Podman, Rancher Desktop, or an unknown engine.

Automatic shutdown now uses the same qualified process/disk observation backend as
explicit review: macOS Apple Silicon, Colima 0.10.3, the default VZ profile. Other
hosts/backends preserve the engine when that proof is unavailable. Metadata commands
retain their 10-second limits; only the exact graceful `colima stop` receives a
60-second command budget, a one-second owned-CLI cancellation grace and a one-second
bounded pipe/handle retirement, followed by a 10-second post-state observation window.
A leader exit and closed output pipes are tracked separately. An escaped pipe holder
does not extend the command indefinitely or authorize signalling a known-exited PID;
unconfirmed command closure is retained as a warning/diagnostic, not orderly success.
Closed diagnostics distinguish leader exit, pipe closure and local handle retirement.
This does not change Colima/VZ's own deadlines or force a VM to exit.

A successful command alone is insufficient. Rehearsal confirms the stopped profile,
absence of the same captured VM process, unchanged backing disks and no remaining
disk holders before reporting the VM off or retiring an unchanged ownership receipt.
If those facts confirm VM-off despite a nonzero, signal or timed-out stop command,
automatic shutdown reports stopped **with a command warning**, retaining closed
status/signal/error-code/elapsed diagnostics; orderly provider shutdown is not claimed.
Unconfirmed observations retain the receipt and report unknown. An unavailable Docker
daemon alone never proves the VM stopped. The explicit reviewed shutdown command
keeps its separate strict result contract.

When the active Docker context is Colima, Rehearsal checks its Docker filesystem before
starting a target. It warns at the configured percentage and refuses below the configured
free-space headroom. The check runs before services are created. Other Docker-compatible
engines remain supported; if they do not expose a portable filesystem measurement,
Rehearsal reports disk capacity as unavailable instead of guessing.

## Shut down the VM explicitly

In builds advertising `containerEngineLifecycle: 1`, use `rehearsal engine status`
to inspect engine and VM state, then `rehearsal engine stop` to review whole-VM
shutdown. A compatible editor exposes the same review in its persistent engine
control. This differs from `stop`, which stops this project's targets, and from
automatic owned-idle shutdown, which still needs its original startup receipt.

Explicit review can cover a manually started VM without pretending Rehearsal
started it. It shows shared containers and binds the local selection, daemon,
profile, boot, captured VM process, backing disks and workload snapshot. Apply
requires the exact confirmation, the shared startup/shutdown lease and fresh
unchanged evidence. Known project operations, unknown coordination or changed
workloads refuse shutdown. Other tools need not obey this cooperative lease;
review all affected work before confirming the whole-VM interruption.

The initial shutdown backend is the macOS Apple Silicon default Colima profile
using Colima 0.10.3 and VZ, with the required process and disk proofs.
Other Docker-compatible engines remain observable where supported, but a vendor
name does not qualify its shutdown behavior. Native Linux Docker is not assumed
to be a VM, and WSL support does not authorize stopping a Windows-hosted engine
or the WSL distribution. Unsupported shutdown remains visible with an explanation;
use that backend's own controls until its adapter is separately qualified.

Shutdown is graceful and bounded. It never force-kills the VM, deletes a profile,
prunes Docker, removes databases/volumes/images or manufactures an ownership receipt.
Confirmed shutdown requires a positive stopped-profile observation and disappearance
of the same captured VM process. An unavailable daemon, an exit code, cancellation
or a stopped profile without that process binding is insufficient proof. A result
can remain unknown after dispatch; inspect again before deciding what to do next.
Colima itself may remove its Docker context while stopping. Rehearsal reports the
later selection separately and never silently selects another engine.
See the [command contract](commands.md#engine-status-and-reviewed-vm-shutdown).

## Choose when database targets stop

The root config makes persistence explicit. Container-retirement-capable builds default
to bounded, data-preserving completion:

```js
lifecycle: {
  run: "stop-after-run",
  open: "stop-on-application-exit",
},
```

`run` accepts `keep-until-stop`, `stop-after-run` or `discard-after-run`. `open` accepts
`keep-until-stop`, `stop-on-application-exit` or `discard-on-application-exit`. Stop modes stop every
configured Rehearsal target in reverse dependency order after the command finishes,
fails after startup, times out, or is interrupted. Lifecycle choices govern targets,
not engine ownership; they do not enable Colima shutdown. The separate
`stopOwnedColimaWhenIdle` policy still requires its own opt-in and ownership checks.

Stopping preserves database and Storage volumes, applied migrations and sandbox edits.
In builds advertising `rehearsalContracts.containerRetirement: 1`, PostgreSQL stop also
retires its exact stopped container shell automatically, without force or volume removal.
It writes a private recovery receipt before removal. Start reconstructs the container from
the verified receipt, original image and unchanged data volume; missing or changed recovery
evidence refuses instead of resetting the database. Supabase uses its provider-owned stop
and resume path. Container IDs may change; retained volume identity and data must not.

Retirement also guards the PostgreSQL marker against older tools that would otherwise
reset a missing container. Its exact previous bytes stay in the private
`baseline.pre-retirement.json` backup. Compatible tools understand the retained-marker
protocol; older tools refuse it. Upgrade the tool to resume retained data—do not use a
reset to resolve a version mismatch. The guard remains after reconstruction.

Discard modes explicitly authorize automatic deletion of the owned runtime and its data
volumes after successful startup, including subsequent proof failure, timeout or interruption.
Use them only for disposable runs. They preserve the immutable baseline, keys and other
projects. Protected targets refuse discard modes before runtime execution. Failed or
unreceipted startup with uncertain ownership remains retained for recovery; it is never
guessed disposable. Cleanup failures remain failures.
Published core 1.3 and earlier retain their previous defaults. Existing explicit
`keep-until-stop` remains an intentional choice for active hands-on testing; finish it
with `stop`. New configurations and omitted lifecycle fields use the bounded defaults
above, so a completed run or closed application does not leave an idle stack.
`explain --json`, `run --json` and `open --json` report the selected mode, runtime state
and whether runtime data was preserved or removed.

## What remains after a command?

- `run` always stops its transient application proof process. Its configured lifecycle
  keeps the database target available, stops it with data preserved, or explicitly discards it.
- `open` keeps the application and databases available until the application session is
  interrupted. Its configured lifecycle then keeps, stops or explicitly discards the database targets.
- `stop` stops every configured Rehearsal target in reverse dependency order and retains
  its local data.
- `start` resumes a stopped target, reusing compatible state.
- `reset` recreates the target from the active immutable baseline.
- `discard` removes the selected disposable target. It is the data-destructive runtime
  operation and retains the immutable baseline.

After Supabase starts, Rehearsal changes only containers with the exact configured
Supabase project label to Docker's `no` restart policy. This does not remove containers
or volumes. It prevents a later Docker restart from silently waking stopped Rehearsal
stacks; `rehearsal start` still resumes them normally.

## A low-memory daily workflow

1. Start your Docker-compatible engine.
2. Set `lifecycle.run` to `stop-after-run` for automation or
   `lifecycle.open` to `stop-on-application-exit` for bounded hands-on sessions.
3. Run `rehearsal run` or `rehearsal open`. With `keep-until-stop`, run
   `rehearsal stop` when finished.
4. Check other projects before stopping the shared engine:

   ```bash
   docker ps
   ```

5. If nothing else needs Docker, review `rehearsal engine stop` in a capable build
   and confirm its exact shared impact. For an unsupported backend, use its own
   shutdown control.

Rehearsal intentionally does not infer that every running container belongs to it. It
also never runs a global Docker prune. Database and Storage volumes are not deleted by
`stop`.

If a multi-target `run` or sandbox startup fails partway through, a configured
stop-after-run or stop-on-application-exit policy stops only targets with a
successful manager receipt from that invocation. Rejected, failed or unattempted
targets are not guessed to be started. Within a failed `start`, or a failed `run`
with stop-after-run selected, package-owned startup inspection additionally stops
only exact containers proved newly created or newly activated by that invocation.
The snapshot is captured after the existing explicit engine startup/preflights and
before target services change—not by booting Docker just to inspect it. Originally
running containers and their same-name rollback replacements remain protected.
Unknown ownership, endpoint/configuration drift, or unavailable state leaves
resources intact and returns retained-resource diagnostics; it is not permission
for broad cleanup. This conservative unreceipted-startup teardown does not delete data.

Completed-predecessor teardown uses the selected stop or explicit discard policy, runs in
reverse order under cancellation protection and reports both the original and any cleanup failure.
The shared engine and untouched targets are not stopped. `keep-until-stop` retains
its explicitly persistent behavior on failure.

## Completed container retirement

The public `@rehearsal-db/core/resource-lifecycle` API owns container-only retirement.
Test Lab uses this same product boundary; it does not need its own competing garbage
collector. A trusted completion hook supplies explicit completed-disposable claims and
exact ownership labels. Manual callers preview `cleanup containers` and confirm its exact
digest. See the [command reference](commands.md#completed-container-retirement).

Retirement requires immutable container IDs, a pinned local endpoint and daemon identity,
unchanged ownership and stopped state. It removes only the container writable layer, using
neither force nor volume-removal flags. Volume names, creation identities and drivers are
verified before and after. Running races, changed engines, conflicting ownership and unknown
state refuse. A partial operation reports each known or unknown outcome and stops the batch.
Caller-owned bind-mounted files and evidence remain outside deletion scope.

Stopped or old does not mean completed. Persistent manual sessions and failure recovery need
an explicit completion decision. This feature does not globally prune Docker, automatically
erase databases or remove shared images. Retained volumes and images still consume disk;
use the existing resource inventory, budget and reviewed discard/image-cleanup policies for
those costs. No reclaimed-byte estimate is inferred from a container count.

## Choosing PostgreSQL or Supabase

Use the PostgreSQL target for migration, schema, trigger, privacy, and ordinary relational
data checks that do not require Supabase services. It uses one database container.

Use the Supabase target when the proof needs Auth, Storage, PostgREST, or the local API
gateway. Its default `application` profile omits Studio, Realtime, Edge Functions,
Analytics/Logflare, Vector, and image transforms. Set `supabase.serviceProfile` to `full`
when a proof uses one of those services. Profile selection is explicit because Rehearsal
will not infer that an application can safely lose a service.

Declare proof dependencies in `application.requiredServices`. PostgreSQL accepts only
`database`. The Supabase `application` profile retains database, Auth, Storage,
PostgREST, gateway, and mail. `studio`, `realtime`, `edge-functions`, `analytics`, and
`image-transforms` require `full`. A required excluded service is refused during config
validation, before startup. No dependency declaration can prove an undeclared need.
The matching local TOML section must also explicitly enable each declared service.
Selecting `full` alone does not override disabled template settings.

The service boundaries are deliberate: Auth and PostgREST require PostgreSQL; Storage
requires its database/API/Auth paths, and the gateway routes those local APIs. Image
transforms are optional to ordinary Storage bytes/downloads. Analytics/Vector, Studio,
Realtime, and Edge Functions are not migration-only dependencies. Keep `full` for proof
scenarios exercising those services rather than silently reducing fidelity.
See Supabase's [architecture](https://supabase.com/docs/guides/getting-started/architecture)
and [Storage service configuration](https://supabase.com/docs/guides/self-hosting/storage/config)
for the provider-owned boundaries; Rehearsal's profiles remain explicit reviewed choices.

### Reading resource measurements

Test Lab's profile report separates fresh-container startup from image downloads. Startup
times the complete reset, health checks, and baseline restoration—not just `docker start`.
Cached images and an already-running engine are reported explicitly.

CPU and memory are short, idle container samples. They exclude host/VM overhead, startup
peaks, and application load; container counts can also vary with the provider CLI version.
These observations help compare profiles, not promise a machine-wide memory budget.

A cold-image or fresh-VM benchmark needs its own disposable, exclusive test environment.
Do not prune shared images or restart a shared engine to manufacture a cold measurement.

### Free local efficiency and planned managed execution

Efficient local profiles, the complete CLI and essential lifecycle/data protections stay
free. Choose the smallest profile that still proves the requested behavior; Rehearsal
does not silently remove declared Auth, Storage or API dependencies to save memory.

Optional managed execution is planned separately and is not available in this release.
Choosing a local profile does not upload data or authorize a hosted operation. See the
[product direction](roadmap.md#efficient-local-execution-and-optional-managed-runs).

### Optional measured headroom and verified reuse

The [resource configuration](configuration.md#measured-capacity-admission) can require
fresh host/engine headroom before a queued runtime phase starts. It includes standing
container use and fails closed on unknown capacity, while leaving stop/discard available.
This adds no hard memory control over other applications or shared engines.

For repeated restores, the optional
[COPY cache](configuration.md#verified-copy-encoding-reuse-and-baseline-sizing) preserves
all verified sanitized rows and exact input bindings while avoiding repeated encoding.
`rehearsal inspect sizing --json` explains actual baseline size and reviewed shape evidence;
it does not silently downsample data or turn short idle measurements into a performance
promise. Existing profile/service-fidelity and owned-engine shutdown boundaries still apply.

## Scheduled review and stale-stop safety

Resource policies configure advisory retention, measured-volume budgets, and scheduled
**review**, not unattended persistent-data cleanup. See
[Resource review policies](configuration.md#resource-review-policies) for the keys.

Container start/stop age is not a signal of user, application, or database inactivity.
`resources.staleAfterSeconds` only enables a review cutoff. Inspect the exact configured
targets, immutable container IDs, ownership, start/stop evidence, and configuration in a
stop-stale preview. Its confirmation binds that set to the verified local engine.
Rehearsal rechecks the evidence before stopping each target in reverse dependency order.
An active application may still be using a long-running container: review your sessions
before confirming. No environment is automatically stopped from age alone.

Stopping stale environments is non-destructive and does not stop the shared engine.
Database/Storage contents, volumes, containers, images, and immutable baselines remain.
Missing or conflicting ownership, unknown activity, remote engines, and changed previews
are refused or excluded. These timestamps never enable automatic idle shutdown.

For genuine application-declared inactivity, `open` offers a separate opt-in foreground
activity contract. Set `lifecycle.openIdleTimeoutSeconds` only after implementing
`application.activity`; see [Foreground application idle shutdown](configuration.md#foreground-application-idle-shutdown).
Unknown activity preserves the running sandbox. This is not a daemon or host-wide
activity detector, and it never treats editor inactivity or quiet containers as user idle.

## Local Resources manager

Detailed browsing and shared-image cleanup require a verified local Docker endpoint.
Remote SSH/TCP endpoints and unknown contexts are refused. Cleanup confirmations are bound
to the selected context and endpoint, so changing engines requires a new preview.

The VS Code Environments page has four resource sections: project environments,
persistent data volumes, shared images, and other projects' containers. Search and filter
by name, state, type, or ownership; sort by size, age, or last observable use. Unknown
measurements stay unknown. Inspection never starts the container engine.

Use `npx rehearsal resources --json` for the versioned individual-resource catalog.
Other projects' resource names and container references are visible for capacity awareness;
their environment variables, credentials, database rows, and configuration are never returned.
Other projects' containers and volumes remain read-only.

Environment inspection also reports optional, versioned provenance from bounded
target-local receipts: the recorded baseline generation/data checksum, migration-set
digest and last restore writer's Rehearsal version. Older receipts may not contain a
writer version; that value stays unknown rather than borrowing the inspector's version.
These are recorded facts, not a fresh database or migration verification. Configured
loopback ports are not proof of listening services. Missing or unsafe receipts report
an unavailable reason without exposing their contents or starting a runtime.
Receipts without a recorded provider remain `unknown` with `provider-not-recorded`;
Rehearsal does not infer compatibility from the configured provider.

Saved profiles organize views of existing targets. They do not clone databases,
select historical runtime copies or change the target a command will execute against.

Presence, receipt compatibility and long-running review are separate facts. An owned
container or data volume proves that an environment was created even if its verification
receipt is missing. An incompatible receipt means its recorded format/provider cannot
be used; a different recorded Rehearsal version alone does not prove incompatibility.
Missing or legacy evidence stays unknown. Long-running review uses the configured age
cutoff and observable resource timestamps, not user inactivity. Engine/ownership
unavailability cannot establish that an environment is absent or safe to remove.

Configured sandboxes preserve data on stop/start, including `stop-after-run`. Stopping
workloads does not turn their database/Storage volumes into disposable helpers. An
explicitly reviewed `run` or `reset` can replace data and volumes from the baseline;
discard removes volumes. Persistent does not mean immutable sandbox data or stable
volume IDs across reset. Unknown and other-project resources remain read-only.

### Inventory scope and temporary helpers

Rehearsal currently manages configured database environments, not a separate class of
temporary Docker helpers. Every configured database and Storage volume is persistent,
including with `stop-after-run`. The legacy `disposable` retention alternative is not
emitted for these environments and does not enable helper discovery or deletion.

Helper-looking names, extra labels, age, or missing verification never prove that a
resource is disposable. Provider-internal containers and test-fixture helpers have no
separate package helper-ownership contract; unknown or conflicting ownership stays
protected. Temporary application processes and files are cleaned up by their owning
operation, not classified as disposable Docker data.

If a future feature needs Docker helpers, it must first define operation-bound ownership,
exact resource IDs, the local-engine binding, and persistent-volume protection. There is
no helper cleanup setting to enable today.

Each environment can have a friendly name and protection policy in its own config:

```js
runtime: {
  displayName: "Migration playground",
  protected: true,
  // Keep the existing projectId, provider, ports, and other runtime settings.
}
```

Renaming changes only the display name. Docker names, labels, and `projectId` stay
unchanged. Protection refuses `run`, `reset`, `migrate`, `discard`, and runtime cleanup before
replacing data. `start` and `stop` still preserve the sandbox. Baseline retention is a
separate existing policy. The extension reviews an exact configuration diff before
saving a name or protection change; complex configurations remain available for manual editing.

Volumes hold persistent database or Storage data. They are never individually deleted
from this manager. Use the owning environment's reviewed discard instead. Attached
includes references from stopped containers. Last use means the latest observable
container start/stop time, not a measurement of database or file access.

Only older official Supabase images with no running **or stopped** container references
can be selected for image cleanup. The newest service image and images with additional
non-Supabase tags remain protected. The editor shows the exact tags, full IDs, estimate,
and zero selected data volumes before confirmation. Shared image layers mean the estimate
is an upper bound, not guaranteed recovered disk space. The CLI equivalent is:

```bash
npx rehearsal cleanup --images-only --image-id=sha256:FULL_IMAGE_ID
```

Review its digest and rerun the same selection with `--write` and
`--confirm-cleanup=FULL_DIGEST`. Image-only cleanup does not select baseline generations,
containers, or data volumes. Rehearsal rechecks eligibility, tags, and all container
references before removal. It uses individual image removal without force, following
[Docker's pruning guidance](https://docs.docker.com/engine/manage-resources/pruning/).

## Diagnosing unexpected activity

`rehearsal activity --json` reports the current owned operation and bounded recent
stage history. Only fixed event codes, reviewed target names, timestamps, durations
and outcome states are retained—never application output, credentials or error
messages. A missing progress record is reported as unavailable, not inferred from
process names or Docker activity.

Recent history contains up to 20 terminal operation records in an owner-only,
project-bound temporary cache. It may be absent after cache cleanup or an abrupt
process exit; it is not an audit log, task tracker or Codex recovery checkpoint.
Inspection does not start services or a background watcher. Completed stages are
actual finished work; a combined runtime lifecycle stage does not claim separate
restore and migration measurements.

Start with Rehearsal's read-only inventory; it never starts Docker:

```bash
npx rehearsal environments
npx rehearsal environments --json
```

It reports only the configured project IDs and exact provider ownership labels. It shows
running/stopped state, container and volume counts, current owned-container CPU and
memory, owned-volume disk usage when Docker can measure it, last observable activity,
restart policies, retention intent, Docker's
resource summary, and Colima disk capacity when measurable. A stopped shared engine is
reported as stopped, not started; its environments are marked `unavailable` because
Rehearsal cannot honestly prove whether their retained resources are present. Then use
lower-level checks when needed:

```bash
docker context show
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Label "com.supabase.cli.project"}}'
docker stats --no-stream
colima status
```

For each container, inspect its project ownership and restart policy before taking any
action:

```bash
docker inspect --format '{{json .Config.Labels}} {{.HostConfig.RestartPolicy.Name}}' CONTAINER
```

Do not remove anonymous volumes or old images based on names alone. Use `rehearsal
cleanup` for package-owned baseline retention and its reviewed, opt-in image cleanup.
Stopped owned runtimes are marked `preview-required`; nothing is deleted from inventory.
Use `rehearsal cleanup --include-runtime` from that configuration for the exact reviewed
removal plan. Ambiguous, foreign, and unlabeled resources are never cleanup candidates.
