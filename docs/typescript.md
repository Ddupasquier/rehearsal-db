# TypeScript

Rehearsal includes types for its documented public APIs. TypeScript is optional: the CLI and the
generated `rehearsal.config.mjs` work in JavaScript, TypeScript, CommonJS, and ESM
applications.

## Type-check the generated config

Keep the generated configuration as `.mjs`. The `// @ts-check` line and
`defineRehearsalConfig` provide editor feedback without adding a build step or asking
Node.js to execute a TypeScript config file.

<!-- checked-example: javascript-config -->

```js
// @ts-check
import { defineRehearsalConfig } from "@rehearsal-db/core";

export default defineRehearsalConfig({
  schemaVersion: 1,
  project: { name: "example-postgresql-app" },
  postgresql: { migrationDirectory: "migrations" },
  baseline: {
    sanitizationPolicy: "rehearsal/sanitization-policy.json",
  },
  application: {
    startCommand: "npm run dev",
    proofCommand: "npm test",
  },
  runtime: {
    target: "postgresql",
    databasePort: 55432,
  },
});
```

This catches misspelled keys, missing required values, invalid runtime targets, and wrong
value types before Rehearsal starts. Runtime validation remains authoritative and still
fails closed when a configuration is unsafe.

## Import the public types

Application tooling may import types from the package root. Type-only imports disappear
from compiled JavaScript and do not start Rehearsal.

<!-- checked-example: type-usage -->

```ts
import type {
  NormalizedRehearsalConfig,
  RehearsalConfig,
  RehearsalConfigVersion,
} from "@rehearsal-db/core";

export const schemaVersion: RehearsalConfigVersion = 1;

export const application = {
  startCommand: "npm run dev",
  proofCommand: "npm test",
} satisfies RehearsalConfig["application"];

export const localDatabasePort = (config: NormalizedRehearsalConfig): number =>
  config.runtime.ports.database;
```

## Exported configuration types

| Export                      | Meaning                                                                   |
| --------------------------- | ------------------------------------------------------------------------- |
| `RehearsalConfigVersion`    | The supported configuration format. It is currently the literal type `1`. |
| `RehearsalConfig`           | The reviewed input shape of `rehearsal.config.mjs`.                       |
| `NormalizedRehearsalConfig` | The immutable, defaulted configuration returned by Rehearsal's loader.    |
| `defineRehearsalConfig()`   | Checks a config while preserving its more specific inferred value types.  |

Nested sections are available through indexed access types such as
`RehearsalConfig["application"]`, `RehearsalConfig["runtime"]`, and
`RehearsalConfig["safety"]`. The [configuration reference](configuration.md) explains
what each setting does and remains the source of truth for runtime behavior.

## Type reviewed privacy policies

The advanced privacy entry point exports the normalized policy, table, column, engine,
foreign-key, and source-record types emitted from the same implementation used for
runtime validation. Keep policy input as ordinary JSON-compatible data and use the
validator's typed return value; runtime validation remains the authority for untrusted
files.

<!-- checked-example: privacy-usage -->

```ts
import {
  validateExecutablePrivacyPolicy,
  type ExecutablePrivacyPolicy,
  type PrivacyColumn,
} from "@rehearsal-db/core/privacy";

export const policy: ExecutablePrivacyPolicy = validateExecutablePrivacyPolicy({
  policyVersion: 2,
  migrationCutoff: "20260101000000",
  tables: [
    {
      name: "widgets",
      sourceRows: "STREAM AND SANITIZE",
      columns: [
        {
          name: "id",
          action: "PSEUDONYMIZE",
          recipe: { format: "uuid", namespace: "widget-id" },
          generated: "NEVER",
          identity: "NO",
          foreignKey: null,
        },
      ],
    },
  ],
});

export const identifierColumn: PrivacyColumn = policy.tables[0]!.columns[0]!;
```

## Package implementation and declarations

All shipped Rehearsal implementation source is TypeScript. The package build emits
ordinary ESM JavaScript for Node.js together with declaration files. Consumers do not
need TypeScript, a transpiler, or a TypeScript runtime.

The package-root import, `@rehearsal-db/core`, uses declarations generated from the
same TypeScript implementation that runs at runtime; the small `types/` entry point
only forwards those generated declarations. Advanced subpath imports such as
`@rehearsal-db/core/baseline` and `@rehearsal-db/core/privacy` also receive generated declarations, but they remain
advanced APIs: only their documented exports and behavior are compatibility promises.

Rehearsal's own `npm run typecheck` compiles every example on this page. A documentation
contract also requires the displayed snippets to match those checked files exactly.
