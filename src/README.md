# Source layout

Production code is grouped by the responsibility it owns:

- `application/` starts and proves the project application.
- `baseline/` creates, validates, and stores safe baseline artifacts.
- `cli/` is the human and automation entry point.
- `identity/` associates copied data with verified local users.
- `project/` owns configuration, setup, and support reporting.
- `runtime/` plans, verifies, resets, migrates, and cleans local runtimes.
- `shared/` contains small target-neutral infrastructure.
- `source/` controls approved source access and baseline refresh.
- `targets/` contains the PostgreSQL and Supabase runtime adapters.

Place a new module in the domain that owns its policy. Keep database-specific behavior
behind `targets/`, repository-only checks under `scripts/verification/`, and public
imports behind the export map in `package.json`.
