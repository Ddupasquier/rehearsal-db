const root = document.documentElement;
const base = root.dataset.base;
const sidebar = document.querySelector(".sidebar");
const backdrop = document.querySelector(".mobile-backdrop");
const menuButton = document.querySelector(".menu-button");
const closeMenuButton = document.querySelector(".sidebar-close");
const themeButton = document.querySelector(".theme-button");
const dialog = document.querySelector(".search-dialog");
const searchButton = document.querySelector(".search-button");
const searchInput = dialog?.querySelector("input");
const results = dialog?.querySelector(".search-results");
let searchIndex;

const closeMenu = () => {
  document.body.classList.remove("nav-open");
  menuButton?.setAttribute("aria-expanded", "false");
  syncSidebarAccess();
};

const mobileNavigation = matchMedia("(max-width: 860px)");
const syncSidebarAccess = () => {
  sidebar?.toggleAttribute(
    "inert",
    mobileNavigation.matches && !document.body.classList.contains("nav-open"),
  );
};

menuButton?.addEventListener("click", () => {
  const open = document.body.classList.toggle("nav-open");
  menuButton.setAttribute("aria-expanded", String(open));
  syncSidebarAccess();
});
backdrop?.addEventListener("click", closeMenu);
closeMenuButton?.addEventListener("click", closeMenu);
mobileNavigation.addEventListener("change", syncSidebarAccess);
syncSidebarAccess();
sidebar
  ?.querySelectorAll("a")
  .forEach((link) => link.addEventListener("click", closeMenu));

themeButton?.addEventListener("click", () => {
  root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem("rehearsal-docs-theme", root.dataset.theme);
});

const escapeHtml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

const openSearch = async () => {
  dialog?.showModal();
  searchInput?.focus();
  if (!searchIndex) {
    searchIndex = await fetch(`${base}assets/search-index.json`).then(
      (response) => response.json(),
    );
  }
};

searchButton?.addEventListener("click", openSearch);
dialog?.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
});

const scorePage = (page, terms) => {
  const title = page.title.toLowerCase();
  const headings = page.headings.join(" ").toLowerCase();
  const content = page.content.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (title.includes(term)) score += 12;
    if (headings.includes(term)) score += 5;
    if (content.includes(term)) score += 1;
  }
  return score;
};

searchInput?.addEventListener("input", () => {
  const terms = searchInput.value
    .toLowerCase()
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  if (terms.length === 0) {
    results.innerHTML =
      '<p class="search-hint">Type a command, concept, or error message.</p>';
    return;
  }
  const matches = searchIndex
    .map((page) => ({ page, score: scorePage(page, terms) }))
    .filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 8);
  results.innerHTML = matches.length
    ? matches
        .map(
          ({ page }) =>
            `<a href="${page.href}" role="option"><strong>${escapeHtml(page.title)}</strong><span>${escapeHtml(page.description)}</span></a>`,
        )
        .join("")
    : '<p class="search-hint">No match yet. Try a shorter or more general phrase.</p>';
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMenu();
  const typing = ["INPUT", "TEXTAREA"].includes(
    document.activeElement?.tagName,
  );
  if (event.key === "/" && !typing) {
    event.preventDefault();
    openSearch();
  }
});

const copyText = async (button, value) => {
  await navigator.clipboard.writeText(value);
  const original = button.textContent;
  button.textContent = "Copied";
  setTimeout(() => {
    button.textContent = original;
  }, 1200);
};

document.querySelectorAll(".copy-code").forEach((button) => {
  button.addEventListener("click", () =>
    copyText(
      button,
      button.closest(".code-frame").querySelector("code").textContent,
    ),
  );
});

document.querySelector(".copy-install")?.addEventListener("click", (event) => {
  copyText(
    event.currentTarget,
    document.querySelector(".install-strip code").textContent,
  );
});

const headings = [...document.querySelectorAll(".prose h2[id]")];
const outlineLinks = new Map(
  [...document.querySelectorAll(".page-outline a")].map((link) => [
    link.getAttribute("href").slice(1),
    link,
  ]),
);
if (headings.length > 0 && outlineLinks.size > 0) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        outlineLinks.forEach((link) => link.classList.remove("active"));
        outlineLinks.get(entry.target.id)?.classList.add("active");
      }
    },
    { rootMargin: "-18% 0px -72%" },
  );
  headings.forEach((heading) => observer.observe(heading));
}
