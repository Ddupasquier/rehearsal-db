import packageMetadata from "../../package.json" with { type: "json" };

export const site = Object.freeze({
  name: "Rehearsal",
  homeTitle: "Rehearsal · Test database migrations against real data",
  description:
    "Catch PostgreSQL and Supabase migrations that pass on empty databases but fail on real data—before deploy.",
  url: "https://ddupasquier.github.io/rehearsal-db/",
  package: "https://www.npmjs.com/package/@rehearsal-db/core",
  downloadsBadge:
    "https://img.shields.io/npm/dm/%40rehearsal-db%2Fcore?style=for-the-badge&logo=npm&logoColor=white&label=npm%20downloads&labelColor=1c2a34&color=287b5c",
  repository: "https://github.com/Ddupasquier/rehearsal-db",
  version: packageMetadata.version.replace(/^0\.1\.0-/u, ""),
});

export const groups = Object.freeze([
  {
    label: "Getting started",
    eyebrow: "First steps",
    pages: ["", "getting-started", "vscode", "tutorial"],
  },
  {
    label: "User reference",
    eyebrow: "Find your next answer",
    pages: [
      "updating",
      "troubleshooting",
      "commands",
      "configuration",
      "runtime-lifecycle",
      "baselines",
      "sanitization",
      "production-source",
      "security-model",
      "standalone-workflow",
      "typescript",
      "runtime-policies",
      "adapters",
      "glossary",
      "roadmap",
    ],
  },
  {
    label: "Maintainers",
    eyebrow: "Contribute and publish",
    pages: ["architecture", "stability", "releasing"],
  },
]);

export const pages = Object.freeze([
  {
    slug: "",
    source: "index.md",
    title: "Welcome",
    shortTitle: "Overview",
    description:
      "See why empty-database tests miss risky migration failures and rehearse the real change locally.",
  },
  {
    slug: "getting-started",
    source: "getting-started.md",
    title: "Getting started",
    description: "Install Rehearsal and prepare your first local sandbox.",
  },
  {
    slug: "vscode",
    source: "vscode.md",
    title: "VS Code extension",
    description:
      "Use Rehearsal through a project-aware visual database-change workbench.",
  },
  {
    slug: "tutorial",
    source: "tutorial.md",
    title: "Hands-on tutorial",
    description: "Try the complete workflow in a disposable synthetic project.",
  },
  {
    slug: "updating",
    source: "updating.md",
    title: "Releases and updates",
    description:
      "Update the project CLI or VS Code extension without resetting your sandbox.",
  },
  {
    slug: "troubleshooting",
    source: "troubleshooting.md",
    title: "Troubleshooting",
    description: "Clear fixes for the most common setup and runtime problems.",
  },
  {
    slug: "baselines",
    source: "baselines.md",
    title: "Baselines",
    description:
      "Understand the locked, safe starting point for every rehearsal.",
  },
  {
    slug: "sanitization",
    source: "sanitization.md",
    title: "Sanitization",
    description:
      "Keep sensitive source values out of reusable local test data.",
  },
  {
    slug: "production-source",
    source: "production-source.md",
    title: "Production-shaped preparation",
    shortTitle: "Source preparation",
    description:
      "Prepare an approved copy through a narrow, temporary boundary.",
  },
  {
    slug: "security-model",
    source: "security-model.md",
    title: "Security model",
    description:
      "See the independent barriers that keep rehearsals local and bounded.",
  },
  {
    slug: "standalone-workflow",
    source: "standalone-workflow.md",
    title: "Standalone workflow",
    description:
      "The complete source-to-sandbox contract and its safety gates.",
  },
  {
    slug: "commands",
    source: "commands.md",
    title: "CLI commands",
    description: "A concise guide to every supported Rehearsal command.",
  },
  {
    slug: "configuration",
    source: "configuration.md",
    title: "Configuration",
    description:
      "All supported rehearsal.config.mjs settings, grouped by purpose.",
  },
  {
    slug: "typescript",
    source: "typescript.md",
    title: "TypeScript",
    description:
      "Use Rehearsal's public types without changing the generated configuration format.",
  },
  {
    slug: "runtime-policies",
    source: "runtime-policies.md",
    title: "Runtime and identity policies",
    shortTitle: "Runtime policies",
    description:
      "Declare structural checks and approved local identity association.",
  },
  {
    slug: "adapters",
    source: "adapters.md",
    title: "Database adapters",
    description:
      "Understand the boundary between reusable runtime targets and projects.",
  },
  {
    slug: "glossary",
    source: "glossary.md",
    title: "Glossary",
    description: "Plain-English definitions for Rehearsal terms.",
  },
  {
    slug: "roadmap",
    source: "roadmap.md",
    title: "Roadmap",
    description:
      "What Rehearsal is proving next and what intentionally comes later.",
  },
  {
    slug: "stability",
    source: "stability.md",
    title: "Stability contract",
    description:
      "The stable core compatibility promise and evidence-based release verification policy.",
  },
  {
    slug: "runtime-lifecycle",
    source: "runtime-lifecycle.md",
    title: "Container runtime lifecycle",
    description:
      "Keep Docker and Supabase environments on demand without risking another project's data.",
  },
  {
    slug: "architecture",
    source: "architecture.md",
    title: "Repository architecture",
    shortTitle: "Architecture",
    description:
      "How the source tree keeps project, runtime, and safety concerns separate.",
  },
  {
    slug: "releasing",
    source: "releasing.md",
    title: "Maintainers: publishing Rehearsal",
    shortTitle: "Publishing releases",
    description:
      "For maintainers: publish exact tested bytes through the trusted release process.",
  },
]);

export const pageBySlug = new Map(pages.map((page) => [page.slug, page]));

export const groupForPage = (slug) =>
  groups.find((group) => group.pages.includes(slug));
