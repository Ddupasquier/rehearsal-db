/** Explain native migration-tool metadata without loading project configuration. */
import { detected, decision } from "./project_discovery_contract.mjs";
import type {
  DetectedDiscoveryItem,
  DecisionDiscoveryItem,
} from "./project_discovery_contract.mjs";

export const addPrismaMigrationDiscovery = (
  facts: DetectedDiscoveryItem[],
  decisions: DecisionDiscoveryItem[],
): void => {
  facts.push(
    detected(
      "database.prisma",
      "Native Prisma migration layout",
      "prisma/migrations",
      [
        {
          kind: "file",
          source: "prisma/migrations",
          detail:
            "Native directory metadata is present; project Prisma configuration and environment files were not loaded.",
        },
      ],
    ),
  );
  decisions.push(
    decision(
      "database.migrationTool",
      "Native migration tool",
      "Prisma requires explicit selection",
      "Review the pinned Prisma Migrate 7.10.1 / PostgreSQL workflow before configuring this native history.",
      "A native directory is not a flat timestamped-SQL migration directory, and a package declaration is not conformance evidence.",
      [],
      "postgresql.migrationTool",
    ),
  );
};

export const addDrizzleMigrationDiscovery = (
  facts: DetectedDiscoveryItem[],
  decisions: DecisionDiscoveryItem[],
): void => {
  facts.push(
    detected(
      "database.drizzle",
      "Native Drizzle migration layout",
      "drizzle/meta/_journal.json",
      [
        {
          kind: "file",
          source: "drizzle/meta/_journal.json",
          detail:
            "Native journal metadata is present; project configuration, schema and environment files were not loaded.",
        },
      ],
    ),
  );
  decisions.push(
    decision(
      "database.migrationTool",
      "Native migration tool",
      "Drizzle requires explicit selection",
      "Review pinned Kit 0.31.11 / ORM 0.45.4 / pg 8.23.1 PostgreSQL workflow before configuring this native history.",
      "Directory or dependency metadata is not execution conformance evidence.",
      [],
      "postgresql.migrationTool",
    ),
  );
};

export const addKnexMigrationDiscovery = (
  facts: DetectedDiscoveryItem[],
  decisions: DecisionDiscoveryItem[],
) => {
  facts.push(
    detected("database.knex", "Knex migration metadata", "Knex", [
      {
        kind: "manifest",
        source: "package.json",
        detail:
          "A Knex declaration is present; knexfile, migrations and environment code were not evaluated.",
      },
    ]),
  );
  decisions.push(
    decision(
      "database.migrationTool",
      "Native migration tool",
      "Knex requires isolated execution",
      "Review explicitly pinned Knex 3.3.0 / pg 8.23.1 PostgreSQL and its disposable restricted worker before configuring native JavaScript.",
      "Package metadata is not isolation or native execution conformance evidence; historical file checksums are unavailable.",
      [],
      "postgresql.migrationTool",
    ),
  );
};
