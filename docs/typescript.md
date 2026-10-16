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
  ProjectDiscoveryResult,
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

export const unresolvedChoices = (profile: ProjectDiscoveryResult): number =>
  profile.decisions.length;
```

## Exported configuration types

| Export                       | Meaning                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------- |
| `RehearsalConfigVersion`     | The supported configuration format. It is currently the literal type `1`.                    |
| `RehearsalConfig`            | The reviewed input shape of `rehearsal.config.mjs`.                                          |
| `NormalizedRehearsalConfig`  | The immutable, defaulted configuration returned by Rehearsal's loader.                       |
| `defineRehearsalConfig()`    | Checks a config while preserving its more specific inferred value types.                     |
| `ProjectDiscoveryResult`     | Versioned read-only facts, suggestions, decisions, and field states.                         |
| `RehearsalResourcePolicy`    | Project-owned stale review, advisory retention, volume budget, and review schedule settings. |
| `ApplicationRequiredService` | The closed set of services a project proof can declare as required.                          |
| `ApplicationActivitySample`  | The application's minimal schema-1 busy flag and monotonic activity counter.                 |

`discoverProjectProfile()` and its result types are exported for trusted local tooling.
The function has the same privacy boundary as `rehearsal discover`: it does not import
project modules, read environment files, contact a database, or start Docker. Most editor
clients should prefer the public CLI JSON contract so package execution and version
validation stay in one place.

Nested sections are available through indexed access types such as
`RehearsalConfig["application"]`, `RehearsalConfig["runtime"]`, and
`RehearsalConfig["safety"]`. The [configuration reference](configuration.md) explains
what each setting does and remains the source of truth for runtime behavior.

## Resource inventory classifications

Editor clients should use the versioned `environments --json` contract, not private
implementation imports. Configured entries report `classification.role` as
`configured-environment`, `classification.dataPersistence` as `preserved-on-stop`, and `retention` as
`persistent`. The broader legacy retention alternative is not a supported Docker-helper
capability or permission to delete data. Presence, receipt compatibility, and review due
status remain separate facts; unavailable inspection cannot prove absence. See
[Inventory scope and temporary helpers](runtime-lifecycle.md#inventory-scope-and-temporary-helpers)
for the current boundary.

## Type an explicit application activity route

The route is opt-in application instrumentation, not a health check. Include meaningful
user, API, Auth, Storage and background activity; polling the route itself must not
increment its counter or set busy. Keep shutdown disabled when this evidence is incomplete.
See [Foreground application idle shutdown](configuration.md#foreground-application-idle-shutdown)
for bounds, failure handling and ownership.

<!-- checked-example: activity-usage -->

```ts
import type {
  ApplicationActivitySample,
  RehearsalConfig,
} from "@rehearsal-db/core";

export const idleApplication = {
  startCommand: "npm run dev",
  proofCommand: "npm test",
  readiness: { url: "http://localhost:5175/health", expectedStatus: 200 },
  activity: { url: "http://localhost:5175/rehearsal-activity" },
} satisfies RehearsalConfig["application"];

export const idleLifecycle = {
  open: "stop-on-application-exit",
  openIdleTimeoutSeconds: 900,
} satisfies NonNullable<RehearsalConfig["lifecycle"]>;

export const activityResponse = {
  schemaVersion: 1,
  busy: false,
  activitySequence: 12,
} satisfies ApplicationActivitySample;
```

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

## Type reviewed baseline shapes

The optional shape entry point exports `BaselineShapePolicy`, `BaselineShapeEvidence`,
`ShapeTable`, `ShapeRelationship`, `ShapeDistribution`, `ShapeJointDistribution`,
`ShapeGoal`, and `ShapeRecord`. Input remains
ordinary JSON. Use the validator before sampling; runtime limits and reviewed privacy
coverage still apply. See [Production source](production-source.md#optional-smaller-measured-baselines)
for the complete declaration and its explicit algorithm limits.

Advanced pure graph tools may use `shapeKeyContextFromSchema(policy, sourceSchema)` and
the exported `ShapeKeyContext` / `ShapeSourceSchemaTable` types. Pass that context to
sampling and evidence together. Native preparation supplies it automatically from the
inspected SQL schema; do not infer numeric types by looking at private row values.

<!-- checked-example: shape-usage -->

```ts
import {
  validateBaselineShapePolicy,
  type BaselineShapePolicy,
  type BaselineShapeEvidence,
} from "@rehearsal-db/core/shape";

export const shape: BaselineShapePolicy = validateBaselineShapePolicy({
  shapeVersion: 1,
  seed: "synthetic-widgets-v1",
  maximumRows: 100,
  tables: [{ name: "widgets", key: ["id"], maximumRows: 100, rootRows: 100 }],
});

export const hasMeasuredGoals = (evidence: BaselineShapeEvidence): boolean =>
  evidence.distributions.length > 0;
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
