# Rehearsal compatibility policy

Starting with `1.0.0`, documented public contracts are backward compatible throughout
the `1.x` line. Minor releases may add compatible capabilities; patch releases fix
defects. An intentional breaking change requires a new major version, a changelog
entry and a migration path.

Historical `0.x` releases allowed intentional breaking changes in minor versions,
with changelog and migration guidance. Their patch releases remain compatible within
their minor line. Existing artifacts and granted license rights are unchanged.

The following are compatibility contracts for published releases:

- configuration property names, types, defaults, validation, and schema version;
- baseline format and checksum meaning;
- ordered migration digest semantics and classifications;
- CLI command names, flags, state-changing behavior, and exit codes;
- versioned JSON result and error envelopes;
- the meaning and ordering of verification gates.

A change to any of those requires either a compatible extension or a deliberate version
transition. Rehearsal must never silently reinterpret an old config, baseline, digest,
or successful verification receipt.

The first `1.0.0` release requires external beta evidence, a support policy and the
settled public API described in [the stability policy](docs/stability.md). Supporting
additional database families, package managers or operating systems is not implied.

Rehearsal supports the maintained Node.js release lines verified by its existing CI
matrix: Node.js 22, 24, and 26. Node.js 24 LTS is the recommended default and the
release-build runtime. End-of-life and unverified future release lines are not
supported. A future release may remove a Node.js line after its upstream end-of-life
date, with that change called out in the changelog.

Core 1.1.0's OS helpers accept the same three lines. A terminal or desktop launcher
that cannot find Node does not mean an installed version is unsupported. Select it
through the project's existing version manager or use the helper's explicit executable
path; see [OS setup](installers/README.md). Helpers never install Node or switch a
project's runtime automatically.

Core 1.2.0 introduced optional capability
`rehearsalContracts.migrationInsights: 1` and `inspect insights --json`. It preserves
existing migration-plan v1, baseline formats, digest meaning and failure diagnosis.
Consumers must check the capability and exact plan/file bindings; absent or
unavailable static analysis is not safety evidence. Package publication does not
establish completed editor, accessibility or genuine-provider acceptance.

Core 1.2.0 also introduced optional `rehearsalContracts.migrationImpact: 1` with
`inspect impact` and `measure impact`. Consumers must explicitly select a configured
local target and bind measurement consent to the exact whole-plan digest. Preview
does not contact a database; measurement reads only the current verified sandbox,
without applying migrations, starting/repairing a runtime or changing database data.
Aggregate execution requires PostgreSQL 17 or newer with server-side transaction
deadlines and narrowly supported ordinary-table/built-in semantics; older servers
remain unknown, with no automatic database upgrade.
Supabase measurement uses the ownership-proven local container's built-in
`supabase_admin` socket role so the fixed disk bound and catalog lock can be enforced.
It does not promote `postgres`, change grants, load credentials or connect remotely.
Read-only catalog preflight is separate from the count snapshot. Bounded strong
relation locks precede that snapshot and temporarily block writers and metadata
changes in the selected disposable sandbox; this is not a nonblocking query promise.
Counts are decimal strings or `null` with an explicit unknown reason, never a safety
verdict, sequential simulation or production prediction. Partial/unknown measurement
uses `not_ready` with the existing not-ready exit `1`; normal rehearsal gates and existing JSON contracts
are unchanged. This capability does not claim a new database family or additional
platform/native acceptance.
Older strict editor activity consumers can reject the new `measure impact` operation
kind, including a retained completed receipt. Pair this capability with an editor
consumer explicitly supporting that kind; the CLI does not silently rename the
operation, relax unknown-kind validation or update an active editor installation.

Core 1.3.0 introduces optional `rehearsalContracts.workloadQueue: 1`: local
`workloads` inspection, exact-confirmed dead-holder metadata recovery and opt-in
`resources.workloadQueue` lifecycle admission. Omitted configuration preserves prior
behavior. Participating clients cooperate within the same OS user, boot and process
namespace; older clients and other tools do not participate. This does not measure
available memory, govern standing runtimes or promise a hard machine-capacity budget.
The existing editor field-metadata contract is unchanged. See
[resource review policies](docs/configuration.md#resource-review-policies).

Builds advertising `rehearsalContracts.containerEngineLifecycle: 1` add independent
`engine status` and reviewed `engine stop` commands without requiring project
configuration. Status can observe a supported selected local Docker endpoint;
shutdown is a separate backend capability. The initial adapter requires macOS
Apple Silicon, Colima 0.10.3, VZ and a proven default profile. This does not add
native Windows runtime support, authorize WSL distribution shutdown or qualify
other vendors' shutdown commands. Unknown backends stay observable where supported
and explicitly unsupported for shutdown. The shared lifecycle queue adds
`engine-stop`; older strict clients refuse that ticket instead of bypassing it.
See the [VM shutdown policy](docs/runtime-lifecycle.md#shut-down-the-vm-explicitly)
and [JSON contract](docs/commands.md#engine-status-and-reviewed-vm-shutdown).

## Native Prisma candidate

Unreleased builds advertising `rehearsalContracts.nativeMigrations: 1` add optional
Prisma Migrate 7.10.1/PostgreSQL configuration and baseline format 3. Existing flat
SQL configurations and baseline formats 1/2 retain their meaning. Format 3 requires
an editor that explicitly understands its native history and tool binding; older
strict consumers may refuse it. Do not infer Prisma support from Core 2.0.0 or
Starter 0.1.25. Independent installed-package, native editor and platform
qualification is pending. See the [candidate configuration](docs/configuration.md#native-prisma-migrations--development-candidate).

## Operating systems and execution location

Core 1.0.1's platform boundary distinguishes the computer running VS Code from the
operating system actually executing Node, Docker and Rehearsal. The corresponding editor
changes are delivered with extension 0.1.21. A Windows desktop connected to WSL is not native
Windows execution.

| Execution environment                                                  | Runtime boundary                                                                                                           |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| macOS, Intel or Apple Silicon                                          | POSIX runtime; supported Node and a local Docker-compatible engine required                                                |
| Linux                                                                  | POSIX runtime; Ubuntu 24.04 is the primary PostgreSQL/Supabase fixture environment                                         |
| Windows with WSL 2                                                     | Run Linux Node and Docker inside the distribution, with the project on its Linux filesystem; compatibility preview         |
| Native Windows Node, PowerShell or Command Prompt                      | Version, help and read-only project discovery remain available; runtime/setup/database operations refuse with WSL guidance |
| WSL 1, a WSL project on `/mnt/c` or another Windows-mounted filesystem | Not a supported database-runtime environment                                                                               |
| SSH, Dev Containers, Codespaces or browser-only VS Code                | No end-to-end support claim; different host, filesystem and port-forwarding boundaries need their own verification         |
| iOS, iPadOS, Android, BSD and other unlisted systems                   | Not supported; installing a JavaScript package does not establish a compatible database engine or desktop extension host   |

Do not bypass native Windows refusal with permission bits or a shell wrapper. Native
Windows ACLs, process-tree retirement and baseline filesystem behavior are not certified
by Linux tests. Keep keys, baselines and working files in the WSL Linux home filesystem,
not a Windows share. The package does not move an existing project automatically.
See [Windows and WSL setup](docs/getting-started.md#windows-use-a-wsl-2-linux-workspace).

### What platform verification proves

The separate `Platform compatibility` workflow preserves existing release/check names.
Desktop jobs install the packed package and exercise version/discovery from a path with
spaces and Unicode on real Linux, macOS and Windows runners. Windows also checks the
intentional runtime refusal; a passing Windows job is not a working Windows database.
The Windows 2025 WSL job provisions its own Ubuntu 24.04 distribution, verifies Linux
execution and filesystem location, then runs the existing real PostgreSQL/dependent-target
fixtures against a local Unix-socket Docker Engine. It does not install Docker Desktop
or expose the daemon over TCP. Node uses the official release checksum; Docker packages
use its signed apt repository. These integrity checks are not independent publisher
authentication.

A configured workflow is not passing evidence. Reports identify actual OS, architecture,
installed artifact and exercised boundary. The WSL fixture does not certify native
Windows runtime, WSL Supabase/Auth/Storage, a native Remote-WSL VS Code session, all Linux
distributions, assistive technology or every architecture. Editor Node/controller tests
are separate from real extension-host and browser walkthroughs. Intel/ARM labels and
Windows/WSL are never interchangeable evidence.

The npm install hook may create project scaffolding only when it proves one application
root. Ordinary npm application installs are covered. A workspace is automatic only when
one declaring consumer is already visible in its manifest or lockfile; npm can save a
new `--workspace` declaration after dependency hooks run, so a first workspace install
may use the guided fallback. pnpm and Yarn install layouts are not yet an
automatic-generation contract. Run `npx rehearsal` from the application directory for
all skipped cases. Global, cache, temporary `npx`, and ambiguous multi-application
workspace installs do not receive files.

The PostgreSQL target covers timestamped SQL migrations running in a dedicated local
`postgres` Docker image. Runtime commands reject hosted connection strings and existing
unmanaged servers. The separately opted-in PostgreSQL preparation boundary may use a
reviewed, short-lived source reader; this does not make a hosted database a runtime
target. ORM-specific nested migration formats remain unsupported. Supabase Storage and
Auth behavior apply only to the Supabase runtime.

A primary config may declare flat dependent PostgreSQL or Supabase targets. Each target
must have its own complete config, immutable baseline, project ID, ports, environment
file, and artifact directory. Nested dependency graphs and shared runtime ownership are
not supported.

Executable privacy policy version 2, source-access policy version 1, runtime policy
version 1, and identity policy version 1 are strict declarative contracts. Unknown
fields fail closed. They do not imply support for arbitrary transformations, SQL,
provider administration, consent decisions, or every PostgreSQL extension.
