/**
 * HTTP API the console reads (architecture §1, §2.9). Built-in node:http — the
 * orchestrator is IO glue, not a framework showcase.
 *
 *   GET  /api/options                                                         → backends/providers/skills
 *   POST /api/conversations                      { title, target }            → Conversation
 *   GET  /api/conversations                                                   → Conversation[]
 *   GET  /api/conversations/:id                                              → RenderedConversation
 *   GET  /api/conversations/:id/timeline                                     → LogEntry[] (unified)
 *   POST /api/conversations/:id/sessions         { settings, task|prompt }    → { sessionId }
 */
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, extname, join, normalize, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createConversation,
  list,
  renderConversation,
  startSession,
  type StartSessionInput,
} from "../conversation/service.ts";
import { buildTimeline } from "../logs/timeline.ts";
import { getConversation, listLocalRecents, rememberLocalRecent } from "../state/store.ts";
import type { Target } from "@automations/core";

const CONSOLE_DIST = process.env.AUTOMATIONS_CONSOLE_DIST ?? join(process.cwd(), "apps", "console", "dist");
const execFileAsync = promisify(execFile);

function send(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(data);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*" });
  res.end(text);
}

function mime(path: string): string {
  switch (extname(path)) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

function sendFile(res: ServerResponse, path: string): void {
  res.writeHead(200, { "content-type": mime(path) });
  createReadStream(path).pipe(res);
}

function sendConsole(req: IncomingMessage, res: ServerResponse): void {
  if (!existsSync(CONSOLE_DIST)) {
    return sendText(
      res,
      404,
      "console build not found. Run `npm run build -w @automations/console`, or use Vite dev server with VITE_API_BASE.",
    );
  }
  const url = new URL(req.url ?? "/", "http://localhost");
  const decoded = decodeURIComponent(url.pathname);
  const relative = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const candidate = normalize(join(CONSOLE_DIST, relative));
  const root = normalize(CONSOLE_DIST);
  if (candidate !== root && !candidate.startsWith(`${root}/`)) return sendText(res, 403, "forbidden");
  if (existsSync(candidate) && statSync(candidate).isFile()) return sendFile(res, candidate);
  const index = join(CONSOLE_DIST, "index.html");
  if (existsSync(index)) return sendFile(res, index);
  sendText(res, 404, "console index not found");
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function safeStat(path: string): { isDirectory: boolean; isGit: boolean } | null {
  try {
    const stat = statSync(path);
    if (!stat.isDirectory()) return null;
    return { isDirectory: true, isGit: existsSync(join(path, ".git")) };
  } catch {
    return null;
  }
}

function browseLocal(pathParam: string | null): Record<string, unknown> {
  const requested = pathParam && pathParam.trim() ? pathParam : homedir();
  const current = resolve(requested.replace(/^~(?=\/|$)/, homedir()));
  const stat = safeStat(current);
  if (!stat) throw new Error(`not a readable directory: ${current}`);

  const entries = readdirSync(current, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => {
      const fullPath = join(current, entry.name);
      return {
        name: entry.name,
        path: fullPath,
        isGit: existsSync(join(fullPath, ".git")),
      };
    })
    .sort((a, b) => Number(b.isGit) - Number(a.isGit) || a.name.localeCompare(b.name));

  const parent = dirname(current);
  return {
    current,
    name: basename(current) || current,
    parent: parent === current ? null : parent,
    isGit: stat.isGit,
    entries,
    roots: [
      { label: "Home", path: homedir() },
      { label: "Current repo", path: process.cwd() },
      { label: "Code", path: join(homedir(), "code") },
      { label: "Waymark", path: join(homedir(), "waymark") },
    ].filter((root) => safeStat(root.path)),
    recents: listLocalRecents(),
  };
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

async function chooseNativeFolder(startPath?: string): Promise<string> {
  const fallback = homedir();
  const requested = startPath && startPath.trim() ? resolve(startPath.replace(/^~(?=\/|$)/, homedir())) : fallback;
  const base = safeStat(requested) ? requested : fallback;
  const script = [
    `set defaultFolder to POSIX file ${appleScriptString(base)} as alias`,
    'set chosenFolder to choose folder with prompt "Choose a local checkout" default location defaultFolder',
    "POSIX path of chosenFolder",
  ];
  const { stdout } = await execFileAsync("osascript", script.flatMap((line) => ["-e", line]), { timeout: 120_000 });
  return resolve(stdout.trim());
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    res.end();
    return;
  }
  if (!url.pathname.startsWith("/api/")) return sendConsole(req, res);
  const parts = url.pathname.replace(/^\/api\//, "").split("/").filter(Boolean);
  const method = req.method ?? "GET";

  // /api/options — static capability/options payload for M4. This is honest
  // about what the runner actually registers today; richer discovery can replace
  // it without changing the console contract.
  if (parts[0] === "options" && parts.length === 1 && method === "GET") {
    return send(res, 200, {
      backends: ["local", "container", "daytona"],
      providers: [
        { id: "pi", models: ["anthropic/claude-haiku-4.5", "anthropic/claude-sonnet-4.5", "anthropic/claude-opus-4.1"] },
        { id: "claude-subscription", models: ["sonnet", "opus"] },
      ],
      skills: [{ id: "browser", requires: { backendCapabilities: ["browser"] } }],
    });
  }

  // /api/local/browse and /api/local/recents — local-only operator affordances
  // for choosing a checkout path from the browser. Recents are host-owned state.
  if (parts[0] === "local" && parts[1] === "browse" && method === "GET") {
    try {
      return send(res, 200, browseLocal(url.searchParams.get("path")));
    } catch (err) {
      return send(res, 400, { error: String(err) });
    }
  }
  if (parts[0] === "local" && parts[1] === "recents") {
    if (method === "GET") return send(res, 200, { recents: listLocalRecents() });
    if (method === "POST") {
      const body = await readBody(req);
      const path = typeof body.path === "string" ? resolve(body.path.replace(/^~(?=\/|$)/, homedir())) : "";
      if (!path || !safeStat(path)) return send(res, 400, { error: "path must be a readable directory" });
      return send(res, 200, { recents: rememberLocalRecent(path) });
    }
  }
  if (parts[0] === "local" && parts[1] === "choose-folder" && method === "POST") {
    try {
      const body = await readBody(req);
      const chosen = await chooseNativeFolder(typeof body.path === "string" ? body.path : undefined);
      if (!safeStat(chosen)) return send(res, 400, { error: "chosen path is not a readable directory" });
      return send(res, 200, { path: chosen, recents: rememberLocalRecent(chosen) });
    } catch (err) {
      const message = String(err);
      if (message.includes("User canceled")) return send(res, 400, { cancelled: true, error: "folder selection cancelled" });
      return send(res, 500, { error: `native folder picker failed: ${message}` });
    }
  }

  // /api/conversations
  if (parts[0] === "conversations" && parts.length === 1) {
    if (method === "GET") return send(res, 200, list());
    if (method === "POST") {
      const body = await readBody(req);
      return send(res, 201, createConversation({ title: String(body["title"] ?? "untitled"), target: body["target"] as Target }));
    }
  }

  // /api/conversations/:id  and  /:id/timeline  and  /:id/sessions
  if (parts[0] === "conversations" && parts[1]) {
    const convId = parts[1];
    if (parts.length === 2 && method === "GET") {
      const rendered = renderConversation(convId);
      return rendered ? send(res, 200, rendered) : send(res, 404, { error: "not found" });
    }
    if (parts[2] === "timeline" && method === "GET") {
      if (!getConversation(convId)) return send(res, 404, { error: "not found" });
      const anchor = url.searchParams.get("anchor") === "session" ? "session" : "conversation";
      return send(res, 200, buildTimeline(convId, anchor));
    }
    if (parts[2] === "sessions" && method === "POST") {
      const body = (await readBody(req)) as unknown as StartSessionInput;
      try {
        return send(res, 202, startSession(convId, body));
      } catch (err) {
        return send(res, 400, { error: String(err) });
      }
    }
    if (parts[2] === "sessions" && parts[3] && parts[4] === "stop" && method === "POST") {
      return send(res, 501, { error: "session stop is not implemented yet" });
    }
  }

  send(res, 404, { error: "no route", path: url.pathname });
}

export function startServer(port: number): void {
  const server = createServer((req, res) => {
    route(req, res).catch((err) => send(res, 500, { error: String(err) }));
  });
  server.listen(port, () => {
    process.stdout.write(`orchestrator API on http://localhost:${port}\n`);
  });
}
