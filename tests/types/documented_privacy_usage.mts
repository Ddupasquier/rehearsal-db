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
