# Designing a production source boundary

The npm package does not connect to production and does not ship an extraction command.
That separation is a security boundary: each project must authorize, sanitize, and
audit its own source.

## Recommended flow

1. Define versioned read-only export views containing only approved columns.
2. Grant a temporary role `SELECT` on those views and nothing else.
3. Use a short-lived credential outside shell history and source control.
4. Stream records through the project-owned sanitization policy.
5. Write into a private building generation below `.rehearsal`.
6. Verify counts, checksums, policy coverage, migration history, and secret canaries.
7. Atomically activate the completed generation.
8. Revoke and verify removal of the temporary credential.
9. Delete raw intermediate files and retain only the sanitized artifact.

Use server-side cursors or another bounded streaming mechanism. A full in-memory dump
is not acceptable for large sources. Extraction logs should contain counts and hashes,
never row bodies.

## What not to do

- Do not point `rehearsal.config.mjs` at a hosted URL.
- Do not put a production connection string in `.rehearsal/runtime.env`.
- Do not grant table-wide access merely because a view is inconvenient.
- Do not commit sanitized baselines; sanitized data is still data.
- Do not let the reusable package infer which fields are safe.
- Do not leave the export role provisioned after refresh.

The local execution engine remains useful with synthetic or manually approved baselines.
Production-shaped onboarding is a separate project security exercise.
