# Rehearsal DB

Rehearsal creates a sanitized, production-shaped PostgreSQL environment where teams can
practice migrations and application changes without writing to production.

The project is in early development. The first public release will include the
`@rehearsal/db` package, the `rehearsal` CLI, safety-first defaults, and a complete
new-project guide.

## Planned workflow

```text
production PostgreSQL
        ↓ restricted, read-only extraction
sanitized and verified baseline
        ↓ disposable local restore
candidate migrations and application testing
```

Rehearsal will fail closed when it cannot prove the source boundary, sanitization
coverage, baseline integrity, or local target.

## Status

The standalone package has not been published yet. Setup instructions and the public API
will be added only after the extraction is independently tested in a clean project.

## License

[MIT](LICENSE)
