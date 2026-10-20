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

Rehearsal supports maintained even-numbered Node.js release lines that pass its CI
matrix. Rehearsal 1.0 supports Node.js 22, 24, and 26; Node.js 24 LTS is the recommended
default and the release-build runtime. End-of-life and odd-numbered Node.js releases are
not supported. A future release may remove a Node.js line after its upstream end-of-life
date, with that change called out in the changelog.

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
