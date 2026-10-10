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
},
```

With the default, a stopped engine produces an actionable error. Start Docker Desktop,
Colima, Rancher Desktop, Podman with Docker compatibility, or another supported engine,
then repeat the command.

Setting `autoStartColima: true` is an explicit convenience opt-in. If Docker is
unavailable and the `colima` command exists, Rehearsal runs plain `colima start` and
reports it. Rehearsal does not resize Colima and does not stop the shared engine
automatically. Starting Docker can also wake unrelated containers that use Docker's
`always` or `unless-stopped` restart policy.

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

## Choosing PostgreSQL or Supabase

Use the PostgreSQL target for migration, schema, trigger, privacy, and ordinary relational
data checks that do not require Supabase services. It uses one database container.

Use the Supabase target when the proof needs Auth, Storage, PostgREST, or the local API
gateway. Rehearsal already excludes Realtime, Edge Runtime, Analytics/Logflare, and Vector
from its Supabase stack. A future service-profile feature will make additional optional
services explicit; until then, do not trade away application fidelity merely to reduce a
container count.

## Diagnosing unexpected activity

Start with read-only checks:

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
Shared resource inventory and stale-environment cleanup are tracked separately; until
that lands, stopping a configured target from its own project is the safe path.
