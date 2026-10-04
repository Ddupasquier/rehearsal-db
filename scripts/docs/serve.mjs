import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, isAbsolute, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { buildDocs } from "./build.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const outputRoot = join(repositoryRoot, ".docs-site");
const port = Number(process.env.REHEARSAL_DOCS_PORT ?? 4173);
const base = (await buildDocs()).base;
const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

const server = createServer(async (request, response) => {
  const parsed = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  if (!parsed.pathname.startsWith(base)) {
    response.writeHead(302, { location: base });
    response.end();
    return;
  }
  let decoded;
  try {
    decoded = decodeURIComponent(parsed.pathname.slice(base.length));
  } catch {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
    response.end("Invalid documentation path.");
    return;
  }
  const safe = normalize(decoded);
  let path = join(outputRoot, safe);
  const details = await stat(path).catch(() => null);
  if (details?.isDirectory() || !extname(path)) path = join(path, "index.html");
  const fromOutputRoot = relative(outputRoot, path);
  if (
    fromOutputRoot.startsWith("..") ||
    isAbsolute(fromOutputRoot) ||
    !(await access(path)
      .then(() => true)
      .catch(() => false))
  ) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Documentation page not found.");
    return;
  }
  response.writeHead(200, {
    "content-type": contentTypes[extname(path)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  createReadStream(path).pipe(response);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Rehearsal docs: http://127.0.0.1:${port}${base}`);
  console.log("Press Ctrl+C to stop the preview.");
});
