import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildDocs as buildPublicDocs } from "../../scripts/docs/build.mjs";
import { groups, pageBySlug, pages, site } from "../../scripts/docs/site.mjs";

const repositoryRoot = process.cwd();
let ownedOutput;
let builds = 0;
beforeAll(async () => {
  ownedOutput = await mkdtemp(join(tmpdir(), "documentation-site-"));
});
afterAll(async () => {
  if (ownedOutput) await rm(ownedOutput, { recursive: true, force: true });
});
// Unit builds must not create/change a shared checkout output while another
// worker is checking exact project ancestry. Production defaults are unchanged.
const buildDocs = (options = {}) =>
  buildPublicDocs({
    outputRoot: join(ownedOutput, `site-${++builds}`),
    ...options,
  });

describe("documentation site", () => {
  it("keeps visible reciprocal GitHub and npm links in the shared package README", async () => {
    const [readme, manifest] = await Promise.all([
      readFile(join(repositoryRoot, "README.md"), "utf8"),
      readFile(join(repositoryRoot, "package.json"), "utf8"),
    ]);
    const metadata = JSON.parse(manifest);
    const introduction = readme.split(/^## /mu)[0];
    const textLinks = [
      ...introduction.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/gu),
    ].map(([, href, label]) => ({ href, label }));

    expect(textLinks).toContainEqual({
      href: site.repository,
      label: "Source on GitHub",
    });
    expect(textLinks).toContainEqual({
      href: site.package,
      label: "View on npm",
    });
    expect(textLinks).toContainEqual({
      href: new URL("vscode/", site.url).href,
      label: "Free VS Code Starter",
    });
    expect(site.package).toBe(`https://www.npmjs.com/package/${metadata.name}`);
    expect(metadata.repository.type).toBe("git");
    expect(metadata.repository.url).toBe(`git+${site.repository}.git`);
    expect(metadata.bugs.url).toBe(`${site.repository}/issues`);
    expect(metadata.homepage).toBe(site.url);
    expect(metadata.files).toContain("README.md");
  });

  it("places every page in exactly one task-based navigation group", () => {
    const navigationSlugs = groups.flatMap((group) => group.pages);
    expect(navigationSlugs).toHaveLength(pages.length);
    expect(new Set(navigationSlugs).size).toBe(pages.length);
    expect(new Set(navigationSlugs)).toEqual(
      new Set(pages.map((page) => page.slug)),
    );
    for (const slug of navigationSlugs) expect(pageBySlug.has(slug)).toBe(true);
  });

  it("separates ordinary updates from maintainer publication instructions", async () => {
    expect(groups.map((group) => group.label)).toEqual([
      "Getting started",
      "User reference",
      "Maintainers",
    ]);
    expect(
      groups.find((group) => group.label === "User reference").pages,
    ).toContain("updating");
    expect(groups.find((group) => group.label === "Maintainers").pages).toEqual(
      ["architecture", "stability", "releasing"],
    );
    for (const group of groups.filter(
      (group) => group.label !== "Maintainers",
    )) {
      expect(group.pages).not.toContain("releasing");
      expect(group.pages).not.toContain("architecture");
      expect(group.pages).not.toContain("stability");
    }
    const [updating, publishing] = await Promise.all([
      readFile(join(repositoryRoot, "docs/updating.md"), "utf8"),
      readFile(join(repositoryRoot, "docs/releasing.md"), "utf8"),
    ]);
    expect(updating).toContain(
      "npm install --save-dev --save-exact @rehearsal-db/core@",
    );
    expect(updating).not.toContain("npm publish");
    for (const question of [
      "What changed?",
      "Is my environment supported?",
      "How do I update?",
      "Breaking changes or known limitations?",
      "Where can I verify the package's origin?",
    ]) {
      expect(updating).toContain(`## ${question}`);
    }
    expect(updating).toContain("Do not delete keys, baselines or sandbox data");
    expect(updating).toContain("does not authorize\nproduction access");
    expect(updating).not.toContain("bypass_actors");
    expect(updating).not.toContain("owner attestation");
    expect(publishing).toContain("# Maintainers: publishing Rehearsal");
    expect(publishing).toContain(
      "Audience: Rehearsal maintainers publishing a release.",
    );
    expect(publishing).toContain("updating.md");
  });

  it("builds every declared Markdown page and searchable route", async () => {
    const result = await buildDocs();
    expect(result.pages).toBe(pages.length);
    const updatesHtml = await readFile(
      join(result.outputRoot, "updating/index.html"),
      "utf8",
    );
    expect(updatesHtml).toContain(
      'href="#where-can-i-verify-the-package39s-origin">Where can I verify the package&#039;s origin?</a>',
    );
    expect(updatesHtml).toContain(
      'aria-label="Link to Where can I verify the package&#039;s origin?"',
    );
    expect(updatesHtml).not.toContain("package&amp;#39;s");
    for (const page of pages) {
      await expect(
        access(join(repositoryRoot, "docs", page.source)),
      ).resolves.toBeUndefined();
      const output = join(
        result.outputRoot,
        page.slug ? join(page.slug, "index.html") : "index.html",
      );
      const html = await readFile(output, "utf8");
      expect(html).toContain(`<title>`);
      expect(html).toContain(`aria-label="Documentation navigation"`);
      expect(html).toContain(`aria-label="Search documentation"`);
      expect(html).not.toMatch(/href="\/rehearsal-db\/[^"#]*\.md(?:#|")/u);
      const localReferences = [
        ...html.matchAll(/(?:href|src)="(\/rehearsal-db\/[^"#?]*)/gu),
      ].map((match) => match[1]);
      for (const reference of localReferences) {
        const relative = reference.slice("/rehearsal-db/".length);
        const target =
          relative.startsWith("assets/") || relative === "sitemap.xml"
            ? join(result.outputRoot, relative)
            : join(result.outputRoot, relative, "index.html");
        await expect(access(target)).resolves.toBeUndefined();
      }
    }
    const searchIndex = JSON.parse(
      await readFile(
        join(result.outputRoot, "assets/search-index.json"),
        "utf8",
      ),
    );
    expect(searchIndex).toHaveLength(pages.length);
    expect(searchIndex.map(({ href }) => href)).toEqual(
      pages.map(({ slug }) =>
        slug ? `/rehearsal-db/${slug}/` : "/rehearsal-db/",
      ),
    );
    const sitemap = await readFile(
      join(result.outputRoot, "sitemap.xml"),
      "utf8",
    );
    expect(sitemap).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(sitemap).toContain(
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    );
    const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/gu)].map(
      ([, url]) => url,
    );
    expect(locations).toEqual(
      pages.map(({ slug }) => new URL(slug ? `${slug}/` : "", site.url).href),
    );
    expect(new Set(locations).size).toBe(pages.length);
    for (const [index, page] of pages.entries()) {
      const output = join(result.outputRoot, page.slug, "index.html");
      const html = await readFile(output, "utf8");
      expect(html).toContain(
        `<link rel="canonical" href="${locations[index]}" />`,
      );
      expect(html).toContain(
        `<link rel="sitemap" type="application/xml" href="${new URL("sitemap.xml", site.url).href}" />`,
      );
    }
  });

  it("leads with the problem and publishes complete sharing metadata", async () => {
    const result = await buildDocs();
    const home = await readFile(join(result.outputRoot, "index.html"), "utf8");

    expect(home).toContain("Production still might not.");
    expect(home).toContain("Why an empty database is not enough");
    expect(home).toContain(
      "<title>Rehearsal · Test database migrations against real data</title>",
    );
    expect(home).toContain('property="og:description"');
    expect(home).toContain(
      '<link rel="canonical" href="https://ddupasquier.github.io/rehearsal-db/" />',
    );
    expect(home).toContain("npm install --save-dev @rehearsal-db/core");
    expect(home).toContain(
      'href="/rehearsal-db/vscode/">Free VS Code Starter</a>',
    );
    expect(home).not.toContain("@rehearsal-db/core@beta");
  });

  it("documents the reviewed Starter delivery and its explicit update consent", async () => {
    const source = await readFile(
      join(repositoryRoot, "docs/vscode.md"),
      "utf8",
    );
    expect(source).toContain("rehearsal-vscode/releases/tag/v0.1.25");
    expect(source).toContain("rehearsal-vscode/blob/v0.1.25/LICENSE");
    expect(source).toContain("core also reads bounded");
    expect(source).toContain("No SQL is executed or uploaded");
    expect(source).not.toContain("or project source during passive inspection");
    expect(source).toContain(
      "marketplace.visualstudio.com/items?itemName=rehearsal-db.rehearsal-db",
    );
    expect(source).toContain("Private per-extension view state");
    expect(source).toMatch(
      /Shared VS Code user settings[\s\S]+retain your existing\s+values/u,
    );
    expect(source).toContain("free indefinitely");
    expect(source).toContain(
      "No account, payment card, purchase, trial period, or license activation",
    );
    expect(source).toContain("verified GitHub VSIX");
    expect(source).toContain(
      '"rehearsal.automaticUpdates": { "extension": true, "cli": false }',
    );
    expect(source).toContain("Save preferences");
    expect(source).toContain("machine-scoped VS Code user settings");
    expect(source).toContain("install scripts disabled");
    expect(source).toContain("Turn either option off to revoke");
    expect(source).toContain("never forces a window reload");
    expect(source).not.toContain(
      "GitHub VSIX installations do not auto-update",
    );
    expect(source).not.toContain("bundled 14-day");
    expect(source).not.toContain(
      "Starter/Pro license terms and Marketplace distribution still need approval",
    );
  });

  it("uses reviewed source and public links without replacing an existing output", async () => {
    const temporary = await mkdtemp(
      join(tmpdir(), "rehearsal-docs-export-test-"),
    );
    const outputRoot = join(temporary, "public-site");
    try {
      const result = await buildDocs({
        docsRoot: join(repositoryRoot, "docs"),
        outputRoot,
        base: "/preview/",
        site: {
          url: "https://example.com/preview/?channel=free&source=docs",
          repository: "https://github.com/example/documentation",
          version: "reviewed-release",
          documentationSource: false,
        },
      });
      const home = await readFile(join(outputRoot, "index.html"), "utf8");
      expect(result.base).toBe("/preview/");
      expect(home).toContain(
        'href="https://github.com/example/documentation/issues"',
      );
      expect(home).toContain(
        'href="https://example.com/preview/?channel=free&amp;source=docs"',
      );
      const sitemap = await readFile(join(outputRoot, "sitemap.xml"), "utf8");
      expect(sitemap).toContain(
        "<loc>https://example.com/preview/?channel=free&amp;source=docs</loc>",
      );
      expect(sitemap).not.toContain("channel=free&source=docs");
      expect(sitemap).not.toContain(site.url);
      for (const page of pages) {
        const canonical = new URL(
          page.slug ? `${page.slug}/` : "",
          "https://example.com/preview/?channel=free&source=docs",
        ).href.replaceAll("&", "&amp;");
        const html = await readFile(
          join(outputRoot, page.slug, "index.html"),
          "utf8",
        );
        expect(html).toContain(`<link rel="canonical" href="${canonical}" />`);
        expect(sitemap).toContain(`<loc>${canonical}</loc>`);
        expect(html).toContain('href="/preview/sitemap.xml">Sitemap</a>');
      }
      expect(home).toContain("reviewed-release");
      expect(home).not.toContain("Edit this page");
      await expect(
        access(join(outputRoot, "assets/fonts/fraunces-LICENSE.txt")),
      ).resolves.toBeUndefined();
      await expect(
        access(join(outputRoot, "assets/fonts/dm-sans-LICENSE.txt")),
      ).resolves.toBeUndefined();
      await expect(buildDocs({ outputRoot })).rejects.toThrow();
      expect(await readFile(join(outputRoot, "index.html"), "utf8")).toBe(home);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("refuses an unsafe public base before writing an output", async () => {
    await expect(buildDocs({ base: '/unsafe/"onload=bad/' })).rejects.toThrow(
      "Documentation base must be a root-relative directory path",
    );
  });
});
