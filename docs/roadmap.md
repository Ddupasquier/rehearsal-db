# Next steps

Rehearsal `0.1.0-beta.6` supports guided Supabase and ordinary PostgreSQL rehearsals.
The next work should be driven by real project use before adding more database targets.

## 1. Complete the first real-project acceptance run

Update an existing Supabase application to `0.1.0-beta.6` on its own clean branch, then
prove:

- `doctor` reports `READY`;
- the intended candidate migrations are the only candidates;
- a complete rehearsal and the application proof pass;
- verify, reset, stop, and restart behave as expected.

Record any confusing instruction or unnecessary manual step. Those findings should guide
the next usability changes.

## 2. Simplify baseline onboarding

Make safe records, migration evidence, and sanitization-policy review easier for a new
developer. Reduce manual file preparation without weakening review, checksum, or
local-only safety rules.

## 3. Validate another ordinary PostgreSQL project

Use a non-Supabase application with real migration history and a synthetic baseline.
Fix general PostgreSQL problems before adding provider-specific behavior.

## 4. Consider PostgreSQL service compatibility

Only after the ordinary PostgreSQL workflow is reliable, evaluate compatibility needs
for individual PostgreSQL services. Keep rehearsals disposable and local; hosted database
execution remains outside the current safety model.

## Later

MySQL, MongoDB, and unrelated database families require different migration and restore
behavior. They remain out of scope until the PostgreSQL experience is proven and stable.
