import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Marked } from "marked";
import { groupForPage, groups, pageBySlug, pages, site } from "./site.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const docsRoot = join(repositoryRoot, "docs");
const outputRoot = join(repositoryRoot, ".docs-site");
const requestedBase = process.env.REHEARSAL_DOCS_BASE ?? "/rehearsal-db/";
const baseSegments = requestedBase.split("/").filter(Boolean);
const base = baseSegments.length === 0 ? "/" : `/${baseSegments.join("/")}/`;

const escapeHtml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const stripHtml = (value) =>
  String(value)
    .replaceAll(/<[^>]*>/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();

const slugify = (value) =>
  stripHtml(value)
    .toLowerCase()
    .replaceAll(/[^a-z0-9\s-]/gu, "")
    .trim()
    .replaceAll(/\s+/gu, "-")
    .replaceAll(/-+/gu, "-");

const hrefFor = (slug) => `${base}${slug ? `${slug}/` : ""}`;

const sourceToPage = new Map(pages.map((page) => [page.source, page]));

const rewriteHref = (href) => {
  if (!href || /^(?:[a-z]+:|#|\/)/iu.test(href)) return href;
  const [path, hash] = href.split("#", 2);
  if (!path.endsWith(".md")) return href;
  const page =
    path === "README.md" ? pageBySlug.get("") : sourceToPage.get(path);
  if (!page) return href;
  return `${hrefFor(page.slug)}${hash ? `#${hash}` : ""}`;
};

const renderMarkdown = (source) => {
  const headings = [];
  const usedIds = new Map();
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading({ tokens, depth }) {
        const content = this.parser.parseInline(tokens);
        const baseId = slugify(content) || "section";
        const occurrence = usedIds.get(baseId) ?? 0;
        usedIds.set(baseId, occurrence + 1);
        const id = occurrence === 0 ? baseId : `${baseId}-${occurrence + 1}`;
        if (depth >= 2 && depth <= 3) {
          headings.push({ id, depth, text: stripHtml(content) });
        }
        return `<h${depth} id="${id}">${content}<a class="heading-anchor" href="#${id}" aria-label="Link to ${escapeHtml(stripHtml(content))}">#</a></h${depth}>`;
      },
      link({ href, title, tokens }) {
        const destination = rewriteHref(href);
        const content = this.parser.parseInline(tokens);
        const external = /^https?:/iu.test(destination);
        return `<a href="${escapeHtml(destination)}"${title ? ` title="${escapeHtml(title)}"` : ""}${external ? ' target="_blank" rel="noreferrer"' : ""}>${content}${external ? '<span class="external-mark" aria-hidden="true">↗</span>' : ""}</a>`;
      },
      code({ text, lang }) {
        const language = String(lang ?? "text").split(/\s/u)[0];
        return `<div class="code-frame"><div class="code-label">${escapeHtml(language)}</div><button class="copy-code" type="button">Copy</button><pre><code class="language-${escapeHtml(language)}">${escapeHtml(text)}</code></pre></div>`;
      },
    },
  });
  return { html: marked.parse(source), headings };
};

const icon = (name) => {
  const paths = {
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.2 4.2"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.65 17.65l1.42 1.42M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.65 6.35l1.42-1.42"/>',
    github:
      '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3.3-.4 6.8-1.6 6.8-7A5.4 5.4 0 0 0 19.4 4 5 5 0 0 0 19.3.5S18.2.1 15 2a13.4 13.4 0 0 0-7 0C4.8.1 3.7.5 3.7.5A5 5 0 0 0 3.6 4a5.4 5.4 0 0 0-1.4 3.7c0 5.4 3.5 6.6 6.8 7A4.8 4.8 0 0 0 8 18v4"/><path d="M8 19c-3 .9-3-1.5-4-2"/>',
    arrow: '<path d="M5 12h14M14 7l5 5-5 5"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
  };
  return `<svg class="icon icon-${name}" viewBox="0 0 24 24" aria-hidden="true">${paths[name]}</svg>`;
};

const renderSidebar = (activeSlug) =>
  groups
    .map(
      (group) => `<section class="sidebar-group">
        <p>${escapeHtml(group.label)}</p>
        ${group.pages
          .map((slug) => {
            const page = pageBySlug.get(slug);
            return `<a href="${hrefFor(slug)}"${slug === activeSlug ? ' class="active" aria-current="page"' : ""}>${escapeHtml(page.shortTitle ?? page.title)}</a>`;
          })
          .join("")}
      </section>`,
    )
    .join("");

const renderOutline = (headings) => {
  if (headings.length === 0) return "";
  return `<aside class="page-outline" aria-label="On this page">
    <p>On this page</p>
    ${headings
      .filter((heading) => heading.depth === 2)
      .map(
        (heading) => `<a href="#${heading.id}">${escapeHtml(heading.text)}</a>`,
      )
      .join("")}
  </aside>`;
};

const renderHeader = () => `<header class="site-header">
  <div class="header-inner">
    <button class="icon-button menu-button" type="button" aria-label="Open navigation" aria-expanded="false">${icon("menu")}</button>
    <a class="brand" href="${base}">
      <img src="${base}assets/logo-mark.svg" width="38" height="38" alt="" />
      <span>rehearsal</span><small>${site.version}</small>
    </a>
    <nav class="top-nav" aria-label="Primary navigation">
      <a href="${hrefFor("getting-started")}">Start</a>
      <a href="${hrefFor("baselines")}">Safety</a>
      <a href="${hrefFor("commands")}">Reference</a>
      <a href="${hrefFor("roadmap")}">Roadmap</a>
    </nav>
    <div class="header-actions">
      <button class="search-button" type="button" aria-label="Search documentation" aria-haspopup="dialog">${icon("search")}<span>Search</span><kbd>/</kbd></button>
      <button class="icon-button theme-button" type="button" aria-label="Switch color theme">${icon("sun")}</button>
      <a class="icon-button github-button" href="${site.repository}" aria-label="Rehearsal on GitHub">${icon("github")}</a>
    </div>
  </div>
</header>`;

const renderHero = () => `<section class="hero">
  <div class="hero-copy">
    <p class="eyebrow"><span></span> Safe local migration testing</p>
    <h1>Take database changes<br/><em>for a rehearsal.</em></h1>
    <p class="hero-lede">Restore a safe copy. Apply only what you reviewed. Test the real application before anything important changes.</p>
    <div class="hero-actions">
      <a class="button primary" href="${hrefFor("getting-started")}">Get started ${icon("arrow")}</a>
      <a class="button secondary" href="${hrefFor("tutorial")}">Try the tutorial</a>
    </div>
    <div class="hero-proof" aria-label="Rehearsal guarantees">
      <span>✓ Local only</span><span>✓ Exact approvals</span><span>✓ Your real tests</span>
    </div>
  </div>
  <div class="hero-art" aria-hidden="true">
    <img src="${base}assets/hero-stage.svg" alt="" />
  </div>
</section>
<section class="install-strip" aria-label="Quick install">
  <div><span>01</span><p>Install it</p></div>
  <code>npm install --save-dev @rehearsal-db/core@beta</code>
  <button type="button" class="copy-install">Copy</button>
</section>`;

const renderPager = (page) => {
  const index = pages.findIndex(({ slug }) => slug === page.slug);
  const previous = index > 0 ? pages[index - 1] : null;
  const next = index < pages.length - 1 ? pages[index + 1] : null;
  return `<nav class="page-pager" aria-label="Documentation pages">
    ${previous ? `<a class="pager previous" href="${hrefFor(previous.slug)}"><span>← Previous</span><strong>${escapeHtml(previous.shortTitle ?? previous.title)}</strong></a>` : "<span></span>"}
    ${next ? `<a class="pager next" href="${hrefFor(next.slug)}"><span>Next →</span><strong>${escapeHtml(next.shortTitle ?? next.title)}</strong></a>` : ""}
  </nav>`;
};

const renderSearch = () => `<dialog class="search-dialog">
  <form method="dialog" class="search-shell">
    <div class="search-field">${icon("search")}<input type="search" autocomplete="off" placeholder="Search the docs…" aria-label="Search documentation"/><button value="close" aria-label="Close search">Esc</button></div>
    <div class="search-results" role="listbox"><p class="search-hint">Type a command, concept, or error message.</p></div>
  </form>
</dialog>`;

const renderPage = ({ page, content, headings }) => {
  const group = groupForPage(page.slug);
  const home = page.slug === "";
  const articleContent = home
    ? content.replace(/^<h1[^>]*>[\s\S]*?<\/h1>/u, "")
    : content;
  return `<!doctype html>
<html lang="en" data-base="${base}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="description" content="${escapeHtml(page.description)}" />
  <meta name="theme-color" content="#1c2a34" />
  <title>${home ? site.name : `${page.title} · ${site.name}`}</title>
  <link rel="icon" href="${base}assets/logo-mark.svg" type="image/svg+xml" />
  <link rel="stylesheet" href="${base}assets/site.css" />
  <script>document.documentElement.dataset.theme = localStorage.getItem("rehearsal-docs-theme") || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");</script>
</head>
<body class="${home ? "home" : "doc-page"}">
  <a class="skip-link" href="#content">Skip to content</a>
  ${renderHeader()}
  <div class="mobile-backdrop"></div>
  <aside class="sidebar" aria-label="Documentation navigation">
    <button class="sidebar-close icon-button" type="button" aria-label="Close navigation">${icon("close")}</button>
    <div class="sidebar-intro"><span>Documentation</span><strong>Find your next step</strong></div>
    ${renderSidebar(page.slug)}
    <a class="sidebar-support" href="https://github.com/Ddupasquier/rehearsal-db/issues">Need help? <span>Open an issue ↗</span></a>
  </aside>
  <main id="content" class="page-shell">
    ${home ? renderHero() : `<div class="breadcrumb"><a href="${base}">Docs</a><span>/</span><span>${escapeHtml(group?.label ?? "Reference")}</span></div>`}
    <div class="content-grid">
      <article class="prose${home ? " home-prose" : ""}">${articleContent}${renderPager(page)}</article>
      ${home ? "" : renderOutline(headings)}
    </div>
    <footer class="site-footer"><p>Built for careful changes and calm launches.</p><div><a href="${site.repository}/edit/main/docs/${page.source}">Edit this page ↗</a><a href="${site.repository}">GitHub ↗</a></div></footer>
  </main>
  ${renderSearch()}
  <script type="module" src="${base}assets/site.js"></script>
</body>
</html>`;
};

const ensureParent = async (path) => mkdir(dirname(path), { recursive: true });

const copyAsset = async (source, destination) => {
  await ensureParent(destination);
  await copyFile(source, destination);
};

export const buildDocs = async () => {
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  const searchIndex = [];
  for (const page of pages) {
    const source = await readFile(join(docsRoot, page.source), "utf8");
    const { html, headings } = renderMarkdown(source);
    const destination = join(
      outputRoot,
      page.slug ? join(page.slug, "index.html") : "index.html",
    );
    await ensureParent(destination);
    await writeFile(
      destination,
      renderPage({ page, content: html, headings }),
      "utf8",
    );
    searchIndex.push({
      title: page.title,
      description: page.description,
      href: hrefFor(page.slug),
      headings: headings.map(({ text }) => text),
      content: stripHtml(html),
    });
  }

  const assets = join(outputRoot, "assets");
  await mkdir(join(assets, "fonts"), { recursive: true });
  for (const filename of [
    "site.css",
    "site.js",
    "logo.svg",
    "logo-mark.svg",
    "hero-stage.svg",
  ]) {
    await copyAsset(join(docsRoot, "site", filename), join(assets, filename));
  }
  const fonts = [
    [
      "@fontsource-variable/fraunces/files/fraunces-latin-wonk-normal.woff2",
      "fraunces-wonk.woff2",
    ],
    [
      "@fontsource-variable/fraunces/files/fraunces-latin-wght-italic.woff2",
      "fraunces-italic.woff2",
    ],
    [
      "@fontsource-variable/dm-sans/files/dm-sans-latin-wght-normal.woff2",
      "dm-sans.woff2",
    ],
    [
      "@fontsource-variable/dm-sans/files/dm-sans-latin-wght-italic.woff2",
      "dm-sans-italic.woff2",
    ],
  ];
  for (const [source, destination] of fonts) {
    await copyAsset(
      join(repositoryRoot, "node_modules", source),
      join(assets, "fonts", destination),
    );
  }
  await writeFile(
    join(assets, "search-index.json"),
    `${JSON.stringify(searchIndex)}\n`,
  );
  await writeFile(join(outputRoot, ".nojekyll"), "", "utf8");
  return { outputRoot, pages: pages.length, base };
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await buildDocs();
  console.log(
    `Built ${result.pages} documentation pages in ${result.outputRoot} (base ${result.base}).`,
  );
}
