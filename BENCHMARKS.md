# Rehearsal benchmark baseline

These measurements are regression signals, not performance guarantees. Compare future
runs on equivalent hardware and investigate material regressions before release.

Measured 2026-09-12 on macOS arm64, Apple M1, Node.js 24.18.0, Supabase CLI 2.117.0,
Docker 29.5.2, and local warm container images.

## Large production-shaped baseline

The final pre-extraction corpus contained 1,139,884 sanitized rows across 126 tables and 251
represented migrations with zero candidates. These historical measurements establish a
starting regression signal; they are not bundled test data or a supported performance
guarantee.

| Phase                                      | Time     |
| ------------------------------------------ | -------- |
| Baseline checksum verification             | 682 ms   |
| Migration inventory and candidate planning | 1,012 ms |
| Database reset, restore, and verification  | 83.70 s  |
| Public CLI run plus project app proof      | 105.56 s |

The complete run includes local Supabase stop/start overhead, replaying the historical
schema, streaming the baseline, the project-specific synthetic developer overlay, exact
row/FK verification, candidate reconciliation, and final migration-ledger verification.

## Independent fixture

Measured again on 2026-09-14 with the same local macOS arm64 toolchain after the final
documentation and package-contract sweep.

Corpus: one synthetic row, one table, one represented migration, one valid candidate,
and one deliberately invalid candidate.

| Phase                                         | Time    |
| --------------------------------------------- | ------- |
| Baseline creation and plan                    | 81 ms   |
| Installed-package valid CLI run and app proof | 42.70 s |
| Reset, stop, restart, and discard lifecycle   | 63.95 s |
| Installed-package invalid refusal and cleanup | 35.09 s |

Most fixture time is local Supabase container lifecycle overhead. The fixture installs
the exact packed release candidate before both executions. The failure timing includes
rebuilding the baseline runtime, applying the valid prefix candidate, refusing the
invalid SQL candidate, and removing the untrusted runtime.

## Linux portability proof

Measured 2026-09-12 using Node.js 24.21.0 in Ubuntu Bookworm arm64 against the local
Colima Docker host, Supabase CLI 2.117.0, and the exact installed prospective tarball.
The valid migration and application proof passed in 40.49 seconds. The invalid migration
was refused and its exact project-labelled runtime was removed in 39.39 seconds. This
run exposed and fixed the fresh-runtime cleanup path and proves Linux arm64 behavior;
the same proof remains required in GitHub Actions before public release.

## Regression policy

Record a new equivalent sample before a beta release or after changing baseline format,
streaming, restore, migration application, verification, or local-runtime lifecycle.
Investigate a repeatable increase greater than 25% in a phase. Do not weaken checks to
recover time; optimize only after identifying the measured bottleneck.
