# Container runtime lifecycle

Rehearsal uses a local Docker-compatible engine for disposable PostgreSQL and Supabase
targets. It owns the targets it creates; it does not own the shared engine or another
project's containers.

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
reports it. Rehearsal does not resize Colima and does not stop the shared engine
automatically. Starting Docker can also wake unrelated containers that use Docker's
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

When the active Docker context is Colima, Rehearsal checks its Docker filesystem before
starting a target. It warns at the configured percentage and refuses below the configured
free-space headroom. The check runs before services are created. Other Docker-compatible
engines remain supported; if they do not expose a portable filesystem measurement,
Rehearsal reports disk capacity as unavailable instead of guessing.

## Choose when database targets stop

The root config makes persistence explicit while preserving the existing behavior by
default:

```js
lifecycle: {
  run: "keep-until-stop",
  open: "keep-until-stop",
},
```

`run` accepts `keep-until-stop` or `stop-after-run`. `open` accepts
`keep-until-stop` or `stop-on-application-exit`. The bounded choices stop every
configured Rehearsal target in reverse dependency order after the command finishes,
fails after startup, times out, or is interrupted. They never stop the shared Docker
engine.

Stopping is non-destructive: database and Storage volumes, applied migrations, and
sandbox edits remain available to `start` or `open`. Only the existing explicit `reset`
and `discard` commands replace or remove runtime state. `explain --json`, `run --json`,
and `open --json` report the selected mode and whether the target was left running or
stopped.

## What remains after a command?

- `run` always stops its transient application proof process. Its configured lifecycle
  either keeps the database target available or stops it with data preserved.
- `open` keeps the application and databases available until the application session is
  interrupted. Its configured lifecycle then keeps or stops the database targets.
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

5. If nothing else needs Docker, stop the engine using its own command, such as
   `colima stop`.

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
for broad cleanup. No containers, volumes or data are deleted by this teardown.

Completed-predecessor teardown preserves data, runs in reverse order
under cancellation protection and reports both the original and any stop failure.
The shared engine and untouched targets are not stopped. `keep-until-stop` retains
its explicitly persistent behavior on failure.

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
