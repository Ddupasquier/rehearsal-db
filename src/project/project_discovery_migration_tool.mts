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
