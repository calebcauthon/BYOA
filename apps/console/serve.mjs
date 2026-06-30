/**
 * Minimal, dependency-free static server for the built console SPA.
 *
 * Used as the Railway start command for the standalone console service. Serves
 * files from ./dist, falling back to index.html for client-side routes, and
 * binds the PORT Railway provides. The orchestrator has its own copy of this
 * logic (api/server.ts) for the single-origin deployment; this exists for the
 * separate-service deployment where the console is hosted apart from the API.
 */
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const DIST = join(dirname(fileURLToPath(import.meta.url)), "dist");
const PORT = Number(process.env.PORT ?? 4173);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
};

function mime(path) {
  const dot = path.lastIndexOf(".");
  return (dot >= 0 && MIME[path.slice(dot)]) || "application/octet-stream";
}

function sendFile(res, path) {
  res.writeHead(200, { "content-type": mime(path) });
  createReadStream(path).pipe(res);
}

if (!existsSync(DIST)) {
  console.error(`console build not found at ${DIST}. Run \`npm run build -w @automations/console\` first.`);
  process.exit(1);
}

const root = normalize(DIST);
const indexHtml = join(DIST, "index.html");

createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const decoded = decodeURIComponent(url.pathname);
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const candidate = normalize(join(DIST, relative));

  // Path-traversal guard: candidate must stay inside DIST.
  if (candidate !== root && !candidate.startsWith(`${root}/`)) {
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    return res.end("forbidden");
  }

  if (existsSync(candidate) && statSync(candidate).isFile()) return sendFile(res, candidate);
  // SPA fallback: unknown paths render the app shell for client-side routing.
  if (existsSync(indexHtml)) return sendFile(res, indexHtml);

  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found");
}).listen(PORT, () => {
  console.log(`console listening on :${PORT} (serving ${DIST})`);
});
