import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { buildDocs } from "../../scripts/docs/build.mjs";
import { groups, pageBySlug, pages, site } from "../../scripts/docs/site.mjs";

const repositoryRoot = process.cwd();

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

  it("builds every declared Markdown page and searchable route", async () => {
    const result = await buildDocs();
    expect(result.pages).toBe(pages.length);
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
        const target = relative.startsWith("assets/")
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
    expect(home).not.toContain("@rehearsal-db/core@beta");
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
          url: "https://example.com/preview/",
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
      expect(home).toContain('href="https://example.com/preview/"');
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
