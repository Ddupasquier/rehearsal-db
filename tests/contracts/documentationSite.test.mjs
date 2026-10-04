import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDocs } from "../../scripts/docs/build.mjs";
import { groups, pageBySlug, pages } from "../../scripts/docs/site.mjs";

const repositoryRoot = process.cwd();

describe("documentation site", () => {
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
});
