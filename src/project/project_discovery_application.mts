/**
 * Detect project runtime and application conventions without exposing script
 * bodies or executing project-owned code.
 */

import type {
  DecisionDiscoveryItem,
  DetectedDiscoveryItem,
  DiscoveryEvidence,
  PackageManifest,
  SuggestedDiscoveryItem,
} from "./project_discovery_contract.mjs";
import {
  decision,
  detected,
  isRecord,
  packageManagerFromManifest,
  packageManagerInvocation,
  suggested,
} from "./project_discovery_contract.mjs";
import {
  metadataKind,
  readBoundedProjectFile,
} from "./project_discovery_metadata.mjs";

const frameworkCandidates = [
  { packages: ["vite"], label: "Vite", defaultPort: 5173 },
  { packages: ["next"], label: "Next.js", defaultPort: 3000 },
  { packages: ["astro"], label: "Astro", defaultPort: 4321 },
  { packages: ["nuxt"], label: "Nuxt", defaultPort: 3000 },
  { packages: ["@sveltejs/kit"], label: "SvelteKit", defaultPort: 5173 },
  { packages: ["@remix-run/dev"], label: "Remix", defaultPort: 3000 },
] as const;

export interface ApplicationDiscovery {
  readonly detected: readonly DetectedDiscoveryItem[];
  readonly suggested: readonly SuggestedDiscoveryItem[];
  readonly decisions: readonly DecisionDiscoveryItem[];
}

const explicitPort = (command: string | undefined): number | null => {
  if (!command) return null;
  const match = /(?:^|\s)(?:--port(?:=|\s+)|-p\s+)(\d{2,5})(?:\s|$)/u.exec(
    command,
  );
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : null;
};

export const discoverApplication = async ({
  root,
  manifest,
  scripts,
  dependencies,
}: {
  root: string;
  manifest: PackageManifest;
  scripts: Readonly<Record<string, string>>;
  dependencies: Readonly<Record<string, string>>;
}): Promise<ApplicationDiscovery> => {
  const facts: DetectedDiscoveryItem[] = [];
  const suggestions: SuggestedDiscoveryItem[] = [];
  const decisions: DecisionDiscoveryItem[] = [];

  facts.push(
    detected("runtime.node.active", "Active Node.js runtime", process.version, [
      {
        kind: "runtime_probe",
        source: "process.version",
        detail: "Version running the Rehearsal discovery command.",
      },
    ]),
  );

  const engines = isRecord(manifest.engines) ? manifest.engines : {};
  const nodeDeclarations: { source: string; value: string }[] = [];
  if (typeof engines.node === "string" && engines.node.trim()) {
    nodeDeclarations.push({
      source: "package.json#engines.node",
      value: engines.node.trim(),
    });
  }
  for (const path of [".nvmrc", ".node-version"] as const) {
    const value = (await readBoundedProjectFile(root, path))?.trim();
    if (value) nodeDeclarations.push({ source: path, value });
  }
  if (nodeDeclarations.length > 0) {
    facts.push(
      detected(
        "runtime.node.declared",
        "Declared Node.js version",
        [...new Set(nodeDeclarations.map(({ value }) => value))],
        nodeDeclarations.map(({ source, value }) => ({
          kind: source.startsWith("package.json") ? "manifest" : "file",
          source,
          detail: `Declares ${value}.`,
        })),
      ),
    );
  }

  const lockManagers = (
    await Promise.all(
      (
        [
          ["npm", "package-lock.json"],
          ["pnpm", "pnpm-lock.yaml"],
          ["yarn", "yarn.lock"],
        ] as const
      ).map(async ([manager, path]) => ({
        manager,
        path,
        exists: (await metadataKind(root, path)) === "file",
      })),
    )
  ).filter(({ exists }) => exists);
  const declaredManager = packageManagerFromManifest(manifest.packageManager);
  const managerCandidates = new Set([
    ...lockManagers.map(({ manager }) => manager),
    ...(declaredManager ? [declaredManager] : []),
  ]);
  const managerEvidence: DiscoveryEvidence[] = [
    ...lockManagers.map(({ manager, path }) => ({
      kind: "file" as const,
      source: path,
      detail: `${manager} lockfile is present.`,
    })),
    ...(declaredManager
      ? [
          {
            kind: "manifest" as const,
            source: "package.json#packageManager",
            detail: `Declares ${String(manifest.packageManager)}.`,
          },
        ]
      : []),
  ];
  let packageManager = "npm";
  if (managerCandidates.size === 1) {
    packageManager = [...managerCandidates][0]!;
    facts.push(
      detected(
        "package.manager",
        "Package manager",
        packageManager,
        managerEvidence,
      ),
    );
  } else if (managerCandidates.size > 1) {
    decisions.push(
      decision(
        "package.manager",
        "Package manager",
        [...managerCandidates],
        "Which package manager owns this project?",
        "The manifest and lockfiles point to more than one package manager.",
        managerEvidence,
      ),
    );
  } else {
    suggestions.push(
      suggested(
        "package.manager",
        "Package manager",
        "npm",
        "low",
        "No lockfile or packageManager declaration was found.",
        [],
      ),
    );
  }

  const relevantScripts = [
    "dev:rehearsal",
    "dev",
    "start",
    "verify:feature",
    "test",
    "check",
    "build",
  ].filter((name) => typeof scripts[name] === "string");
  if (relevantScripts.length > 0) {
    facts.push(
      detected(
        "package.scripts",
        "Available package scripts",
        relevantScripts,
        [
          {
            kind: "manifest",
            source: "package.json#scripts",
            detail:
              "Only conventional application, proof, test, check, and build script names are exposed; command bodies stay internal.",
          },
        ],
      ),
    );
  }

  const frameworks = frameworkCandidates.filter(({ packages }) =>
    packages.some((name) => name in dependencies),
  );
  if (frameworks.length === 1) {
    const framework = frameworks[0]!;
    suggestions.push(
      suggested(
        "application.framework",
        "Application framework",
        framework.label,
        "high",
        "Confirm this is the application Rehearsal should launch.",
        framework.packages
          .filter((name) => name in dependencies)
          .map((name) => ({
            kind: "manifest" as const,
            source: `package.json#${name}`,
            detail: `${name} is declared as a dependency.`,
          })),
      ),
    );
  } else if (frameworks.length > 1) {
    decisions.push(
      decision(
        "application.framework",
        "Application framework",
        frameworks.map(({ label }) => label),
        "Which application should Rehearsal launch?",
        "Multiple application frameworks are declared.",
        frameworks.flatMap(({ packages, label }) =>
          packages
            .filter((name) => name in dependencies)
            .map((name) => ({
              kind: "manifest" as const,
              source: `package.json#${name}`,
              detail: `${label} dependency is present.`,
            })),
        ),
        "application.startCommand",
      ),
    );
  }

  const startScript = ["dev:rehearsal", "dev", "start"].find(
    (name) => typeof scripts[name] === "string",
  );
  if (startScript && managerCandidates.size <= 1) {
    suggestions.push(
      suggested(
        "application.startCommand",
        "Application start command",
        packageManagerInvocation(packageManager, startScript),
        "high",
        "Review the command before adding it to Rehearsal.",
        [
          {
            kind: "script",
            source: `package.json#scripts.${startScript}`,
            detail: `The ${startScript} script is defined.`,
          },
        ],
        "application.startCommand",
      ),
    );
  } else if (!startScript) {
    decisions.push(
      decision(
        "application.startCommand",
        "Application start command",
        "Not detected",
        "Which command starts the application locally?",
        "No conventional dev, dev:rehearsal, or start script exists.",
        [],
        "application.startCommand",
      ),
    );
  }

  const proofScript = ["verify:feature", "test", "check"].find(
    (name) => typeof scripts[name] === "string",
  );
  if (proofScript && managerCandidates.size <= 1) {
    suggestions.push(
      suggested(
        "application.proofCommand",
        "Application proof command",
        packageManagerInvocation(packageManager, proofScript),
        "high",
        "Confirm this proves application behavior affected by migrations.",
        [
          {
            kind: "script",
            source: `package.json#scripts.${proofScript}`,
            detail: `The ${proofScript} script is defined.`,
          },
        ],
        "application.proofCommand",
      ),
    );
  } else if (!proofScript) {
    decisions.push(
      decision(
        "application.proofCommand",
        "Application proof command",
        "Not detected",
        "Which command proves the migrated application still works?",
        "No conventional verify:feature, test, or check script exists.",
        [],
        "application.proofCommand",
      ),
    );
  }

  const framework = frameworks.length === 1 ? frameworks[0] : undefined;
  const port = explicitPort(startScript ? scripts[startScript] : undefined);
  const applicationPort = port ?? framework?.defaultPort;
  if (applicationPort) {
    suggestions.push(
      suggested(
        "application.readiness.url",
        "Application URL",
        `http://localhost:${applicationPort}`,
        port ? "high" : "medium",
        "Confirm the exact loopback URL and readiness route.",
        port && startScript
          ? [
              {
                kind: "script",
                source: `package.json#scripts.${startScript}`,
                detail: `A literal local port ${port} is present in the script.`,
              },
            ]
          : framework
            ? [
                {
                  kind: "manifest",
                  source: `package.json#${framework.packages[0]}`,
                  detail: `${framework.label} commonly uses port ${framework.defaultPort}.`,
                },
              ]
            : [],
        "application.readiness.url",
      ),
    );
  } else {
    decisions.push(
      decision(
        "application.readiness.url",
        "Application URL",
        "Not detected",
        "Which loopback URL proves the local application is ready?",
        "No explicit port or single framework default was available.",
        [],
        "application.readiness.url",
      ),
    );
  }

  return {
    detected: facts,
    suggested: suggestions,
    decisions,
  };
};
