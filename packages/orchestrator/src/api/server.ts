/**
 * HTTP API the console reads (architecture §1, §2.9). Built-in node:http — the
 * orchestrator is IO glue, not a framework showcase.
 *
 *   GET  /api/options                                                         → backends/providers/skills
 *   GET  /api/instructions                                                    → Instruction[]
 *   POST /api/instructions                       { id?, name, body }          → Instruction
 *   DELETE /api/instructions/:id                                              → Instruction[]
 *   POST /api/instructions/generate              { description }              → { body }
 *   POST /api/conversations                      { title, target }            → Conversation
 *   GET  /api/conversations                                                   → Conversation[]
 *   GET  /api/conversations/:id                                              → RenderedConversation
 *   GET  /api/conversations/:id/timeline                                     → LogEntry[] (unified)
 *   POST /api/conversations/:id/sessions         { settings, task|prompt, images? } → { sessionId }
 */
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, extname, join, normalize, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  AtCapacityError,
  createConversation,
  list,
  renderConversation,
  startSession,
  type StartSessionInput,
} from "../conversation/service.ts";
import { buildTimeline } from "../logs/timeline.ts";
import {
  deleteInstruction,
  getOwnedConversation,
  listBranchRecents,
  listGithubOrgs,
  listInstructions,
  listLocalRecents,
  saveInstruction,
  readReposCache,
  rememberBranchRecent,
  rememberGithubOrg,
  rememberLocalRecent,
  sessionDir,
  setLastGithubOrg,
  writeReposCache,
} from "../state/store.ts";
import type { Target } from "@automations/core";
import { createIdentity, HostedIdentity } from "../identity/index.ts";
import {
  authEnabled,
  checkPin,
  clearSessionCookie,
  isAuthenticated,
  logAuthStatus,
  setSessionCookie,
} from "./auth.ts";

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

function redirect(res: ServerResponse, location: string): void {
  res.writeHead(302, { location });
  res.end();
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

function normalizeLocalPath(path: string): string {
  return resolve(path.replace(/^~(?=\/|$)/, homedir()));
}

function browseLocal(pathParam: string | null): Record<string, unknown> {
  const requested = pathParam && pathParam.trim() ? pathParam : homedir();
  const current = normalizeLocalPath(requested);
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
  const requested = startPath && startPath.trim() ? normalizeLocalPath(startPath) : fallback;
  const base = safeStat(requested) ? requested : fallback;
  const script = [
    `set defaultFolder to POSIX file ${appleScriptString(base)} as alias`,
    'set chosenFolder to choose folder with prompt "Choose a local checkout" default location defaultFolder',
    "POSIX path of chosenFolder",
  ];
  const { stdout } = await execFileAsync("osascript", script.flatMap((line) => ["-e", line]), { timeout: 120_000 });
  return resolve(stdout.trim());
}

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", repoPath, ...args], { timeout: 15_000, maxBuffer: 1024 * 1024 });
  return stdout;
}

// owner/name for every repo the gh-authed user can see under `org` (an org or a
// user login). Cached by the caller so the console never waits on this twice.
async function fetchOrgRepos(org: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "gh",
    ["repo", "list", org, "--limit", "500", "--json", "nameWithOwner", "--jq", ".[].nameWithOwner"],
    { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
  );
  return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

async function fetchGithubOrgs(): Promise<string[]> {
  const { stdout } = await execFileAsync(
    "gh",
    ["api", "user/orgs", "--paginate", "--jq", ".[].login"],
    { timeout: 30_000, maxBuffer: 1024 * 1024 },
  );
  return stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

interface GhIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  updatedAt: string;
}

// Open issues for a repo, as the gh-authed user sees them. Bodies included so the
// console can fill the prompt without a second round-trip.
async function fetchIssues(repo: string): Promise<GhIssue[]> {
  const { stdout } = await execFileAsync(
    "gh",
    ["issue", "list", "--repo", repo, "--state", "open", "--limit", "50", "--json", "number,title,body,url,labels,updatedAt"],
    { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
  );
  const raw = JSON.parse(stdout) as Array<Record<string, unknown>>;
  return raw.map((i) => ({
    number: Number(i.number),
    title: String(i.title ?? ""),
    body: typeof i.body === "string" ? i.body : "",
    url: String(i.url ?? ""),
    labels: Array.isArray(i.labels) ? i.labels.map((l) => String((l as { name?: unknown })?.name ?? "")).filter(Boolean) : [],
    updatedAt: String(i.updatedAt ?? ""),
  }));
}

// The repo's default branch, as the gh-authed user sees it. Used to seed the
// console's "Base branch" field instead of assuming "main".
async function fetchDefaultBranch(repo: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "gh",
    ["repo", "view", repo, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
    { timeout: 30_000, maxBuffer: 1024 * 1024 },
  );
  return stdout.trim();
}

// Turn a short natural-language description into a system prompt via OpenRouter
// (Haiku — cheap + fast for prompt-writing). Reuses OPENROUTER_API_KEY, the same
// key the pi provider consumes; no extra dependency (global fetch, Node 18+).
async function generateInstruction(description: string): Promise<string> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is not set");
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: "anthropic/claude-haiku-4.5",
      max_tokens: 2_000,
      messages: [
        {
          role: "system",
          content:
            "You write concise, effective system prompts for AI coding agents. Given a short description of the desired behavior, output ONLY the system prompt text itself — no preamble, no explanation, no surrounding quotes or markdown fences.",
        },
        { role: "user", content: description },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const body = data.choices?.[0]?.message?.content?.trim();
  if (!body) throw new Error("OpenRouter returned no content");
  return body;
}

function branchFallback(task: string): string {
  const words = task
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 4)
    .join("-");
  return words || "agent-change";
}

async function generateBranchName(task: string): Promise<string> {
  let slug = "";
  const key = process.env.OPENROUTER_API_KEY;
  if (key) {
    try {
      const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        signal: AbortSignal.timeout(8_000),
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: "anthropic/claude-haiku-4.5",
          max_tokens: 40,
          messages: [
            {
              role: "system",
              content:
                "Create a concise git branch slug describing the requested work. Output only 2-5 lowercase ASCII words joined by hyphens. No prefix, punctuation, quotes, markdown, or explanation.",
            },
            { role: "user", content: task.slice(0, 2_000) },
          ],
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
        const candidate = data.choices?.[0]?.message?.content?.trim() ?? "";
        if (/^[a-z0-9]+(?:-[a-z0-9]+){1,4}$/.test(candidate) && candidate.length <= 48) slug = candidate;
      }
    } catch {
      // Branch naming must never prevent a run; use the deterministic fallback.
    }
  }
  if (!slug) slug = branchFallback(task);
  const suffix = `${Date.now().toString(36).slice(-3)}${Math.random().toString(36).slice(2, 5)}`;
  return `auto/${slug.slice(0, 48).replace(/-+$/g, "")}-${suffix}`;
}

function cleanBranch(raw: string): string | null {
  const branch = raw.trim().replace(/^remotes\//, "");
  if (!branch || branch.includes("HEAD ->")) return null;
  return branch;
}

async function listBranches(repoPath: string): Promise<Record<string, unknown>> {
  const path = normalizeLocalPath(repoPath);
  const stat = safeStat(path);
  if (!stat?.isGit) throw new Error(`not a git repository: ${path}`);

  const [currentRaw, localRaw, allRaw] = await Promise.all([
    git(path, ["branch", "--show-current"]).catch(() => ""),
    git(path, ["branch", "--format=%(refname:short)"]),
    git(path, ["branch", "--all", "--format=%(refname:short)"]),
  ]);
  const current = currentRaw.trim();
  const locals = new Set(localRaw.split("\n").map(cleanBranch).filter((b): b is string => b !== null));
  const seen = new Set<string>();
  const branches = allRaw
    .split("\n")
    .map(cleanBranch)
    .filter((branch): branch is string => branch !== null)
    .filter((branch) => {
      if (seen.has(branch)) return false;
      seen.add(branch);
      return true;
    })
    .map((branch) => ({
      name: branch,
      current: branch === current,
      remote: branch.includes("/"),
      local: locals.has(branch),
    }))
    .sort((a, b) => Number(b.current) - Number(a.current) || Number(b.local) - Number(a.local) || a.name.localeCompare(b.name));

  return { repoPath: path, current, branches, recents: listBranchRecents(path) };
}

// The identity adapter for this deployment (local by default). The whole app
// resolves "who is this + what are their credentials" through this one seam.
const identity = createIdentity();

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type,authorization",
    });
    res.end();
    return;
  }
  // The static console shell (JS/CSS/HTML — no data) stays public so the browser
  // can render the login screen; everything sensitive lives under /api and is
  // gated below.
  if (!url.pathname.startsWith("/api/")) return sendConsole(req, res);
  const parts = url.pathname.replace(/^\/api\//, "").split("/").filter(Boolean);
  const method = req.method ?? "GET";

  // --- auth (reachable without a session) ---------------------------------
  if (parts[0] === "auth") {
    if (parts[1] === "session" && method === "GET") {
      if (identity instanceof HostedIdentity) return send(res, 200, await identity.sessionInfo(req));
      return send(res, 200, { authenticated: isAuthenticated(req), required: authEnabled() });
    }
    if (identity instanceof HostedIdentity && (parts[1] === "github" || parts[1] === "google")) {
      const provider = parts[1];
      if (parts.length === 2 && method === "GET") {
        try {
          return redirect(res, await identity.beginOAuth(provider, req, res));
        } catch (err) {
          return send(res, 503, { error: String(err) });
        }
      }
      if (parts[2] === "callback" && method === "GET") {
        try {
          await identity.completeOAuth(provider, req, res, url);
          return redirect(res, "/");
        } catch (err) {
          return redirect(res, `/?auth_error=${encodeURIComponent(String(err))}`);
        }
      }
    }
    if (parts[1] === "login" && method === "POST") {
      if (identity instanceof HostedIdentity) return send(res, 405, { error: "use GitHub or Google SSO" });
      if (!authEnabled()) return send(res, 200, { authenticated: true });
      const body = await readBody(req);
      if (!checkPin(body.pin)) return send(res, 401, { error: "incorrect PIN" });
      setSessionCookie(res, req);
      return send(res, 200, { authenticated: true });
    }
    if (parts[1] === "logout" && method === "POST") {
      if (identity instanceof HostedIdentity) {
        await identity.logout(req, res);
        return send(res, 200, { ok: true });
      }
      clearSessionCookie(res);
      return send(res, 200, { ok: true });
    }
  }

  // Central gate: resolve once and carry the principal through every scoped
  // operation. Hosted accepts either its session cookie or a Bearer API key.
  const principal = await identity.resolvePrincipal(req);
  if (!principal) return send(res, 401, { error: "unauthorized" });

  if (parts[0] === "account" && parts.length === 1 && method === "GET") {
    return send(res, 200, { user: principal, mode: identity.kind });
  }
  if (parts[0] === "account" && parts[1] === "api-keys" && identity instanceof HostedIdentity) {
    if (parts.length === 2 && method === "GET") return send(res, 200, { keys: await identity.listApiKeys(principal.id) });
    if (parts.length === 2 && method === "POST") {
      const body = await readBody(req);
      return send(res, 201, await identity.createApiKey(principal.id, typeof body.name === "string" ? body.name : "API key"));
    }
    if (parts[2] && method === "DELETE") {
      return send(res, (await identity.revokeApiKey(principal.id, parts[2])) ? 200 : 404, { ok: true });
    }
  }

  if (identity.kind === "hosted" && parts[0] === "local") {
    return send(res, 404, { error: "local checkout routes are unavailable in hosted mode" });
  }
  if (
    identity instanceof HostedIdentity &&
    parts[0] === "github" &&
    parts[1] === "orgs" &&
    parts.length === 2 &&
    method === "GET"
  ) {
    return send(res, 200, await identity.listGithubOrgs(principal.id));
  }
  if (
    identity instanceof HostedIdentity &&
    parts[0] === "github" &&
    parts[1] === "install" &&
    method === "GET"
  ) {
    try {
      return redirect(res, await identity.beginGithubInstall(principal.id));
    } catch (err) {
      return send(res, 503, { error: String(err) });
    }
  }
  if (
    identity instanceof HostedIdentity &&
    parts[0] === "github" &&
    parts[1] === "setup" &&
    method === "GET"
  ) {
    try {
      await identity.completeGithubInstall(principal.id, url);
      return redirect(res, "/?github_installed=1");
    } catch (err) {
      return redirect(res, `/?github_error=${encodeURIComponent(String(err))}`);
    }
  }
  if (
    identity instanceof HostedIdentity &&
    parts[0] === "github" &&
    parts[1] === "repos" &&
    method === "GET"
  ) {
    const org = (url.searchParams.get("org") ?? "").trim();
    if (!org) return send(res, 400, { error: "org is required" });
    try {
      const repos = await identity.listGithubRepos(principal.id, org);
      return send(res, 200, { org, repos, fetchedAt: new Date().toISOString(), cached: false });
    } catch (err) {
      return send(res, 409, { error: String(err), installationRequired: true });
    }
  }
  if (
    identity instanceof HostedIdentity &&
    parts[0] === "github" &&
    parts[1] === "issues" &&
    method === "GET"
  ) {
    const repo = (url.searchParams.get("repo") ?? "").trim();
    if (!repo) return send(res, 400, { error: "repo is required" });
    try {
      return send(res, 200, { repo, issues: await identity.listGithubIssues(principal.id, repo) });
    } catch (err) {
      return send(res, 409, { error: String(err), installationRequired: true });
    }
  }
  if (
    identity instanceof HostedIdentity &&
    parts[0] === "github" &&
    parts[1] === "default-branch" &&
    method === "GET"
  ) {
    const repo = (url.searchParams.get("repo") ?? "").trim();
    if (!repo) return send(res, 400, { error: "repo is required" });
    try {
      return send(res, 200, { repo, defaultBranch: await identity.githubDefaultBranch(principal.id, repo) });
    } catch (err) {
      return send(res, 409, { error: String(err), installationRequired: true });
    }
  }
  if (identity.kind === "hosted" && parts[0] === "github") {
    return send(res, 501, { error: "GitHub repository access requires the GitHub App installation phase" });
  }

  // /api/options — static capability/options payload for M4. This is honest
  // about what the runner actually registers today; richer discovery can replace
  // it without changing the console contract.
  if (parts[0] === "options" && parts.length === 1 && method === "GET") {
    return send(res, 200, {
      backends: identity.kind === "hosted" ? ["daytona"] : ["local", "container", "daytona"],
      providers: [
        { id: "pi", models: ["anthropic/claude-haiku-4.5", "anthropic/claude-sonnet-4.5", "anthropic/claude-opus-4.1"] },
        { id: "claude-subscription", models: ["sonnet", "opus"] },
      ],
      skills: [{ id: "browser", requires: { backendCapabilities: ["browser"] } }],
    });
  }

  // /api/instructions — the reusable system-prompt library (host-owned). GET
  // lists; POST creates (no id) or updates (id) and returns the saved record;
  // /generate turns a description into prompt text via an LLM.
  if (parts[0] === "instructions" && parts.length === 1) {
    if (method === "GET") return send(res, 200, { instructions: listInstructions() });
    if (method === "POST") {
      const body = await readBody(req);
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const text = typeof body.body === "string" ? body.body : "";
      if (!name) return send(res, 400, { error: "name is required" });
      if (!text.trim()) return send(res, 400, { error: "body is required" });
      const id = typeof body.id === "string" && body.id ? body.id : undefined;
      return send(res, 200, saveInstruction({ ...(id ? { id } : {}), name, body: text }));
    }
  }
  if (parts[0] === "instructions" && parts[1] === "generate" && parts.length === 2 && method === "POST") {
    const body = await readBody(req);
    const description = typeof body.description === "string" ? body.description.trim() : "";
    if (!description) return send(res, 400, { error: "description is required" });
    try {
      return send(res, 200, { body: await generateInstruction(description) });
    } catch (err) {
      return send(res, 400, { error: String(err) });
    }
  }
  if (parts[0] === "instructions" && parts[1] && parts.length === 2 && method === "DELETE") {
    return send(res, 200, { instructions: deleteInstruction(parts[1]) });
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
      const path = typeof body.path === "string" ? normalizeLocalPath(body.path) : "";
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
  if (parts[0] === "local" && parts[1] === "branches" && method === "GET") {
    const repoPath = url.searchParams.get("repoPath");
    if (!repoPath) return send(res, 400, { error: "repoPath is required" });
    try {
      return send(res, 200, await listBranches(repoPath));
    } catch (err) {
      return send(res, 400, { error: String(err) });
    }
  }
  if (parts[0] === "local" && parts[1] === "branch-recents") {
    if (method === "GET") {
      const repoPath = url.searchParams.get("repoPath");
      if (!repoPath) return send(res, 400, { error: "repoPath is required" });
      return send(res, 200, { recents: listBranchRecents(normalizeLocalPath(repoPath)) });
    }
    if (method === "POST") {
      const body = await readBody(req);
      const repoPath = typeof body.repoPath === "string" ? normalizeLocalPath(body.repoPath) : "";
      const branch = typeof body.branch === "string" ? body.branch.trim() : "";
      if (!repoPath || !safeStat(repoPath)?.isGit) return send(res, 400, { error: "repoPath must be a git repository" });
      if (!branch) return send(res, 400, { error: "branch is required" });
      return send(res, 200, { recents: rememberBranchRecent(repoPath, branch) });
    }
  }

  // /api/github/orgs — saved organizations + last-used, so the operator never
  // re-types an org. /api/github/repos — cached owner/name list for an org; reads
  // the host cache instantly, only shelling out to `gh` on a miss or ?refresh=1.
  if (parts[0] === "github" && parts[1] === "orgs" && parts.length === 2) {
    if (method === "GET") {
      const saved = listGithubOrgs();
      if (saved.orgs.length > 0) return send(res, 200, saved);
      try {
        return send(res, 200, { orgs: await fetchGithubOrgs(), lastOrg: null });
      } catch {
        return send(res, 200, saved);
      }
    }
    if (method === "POST") {
      const body = await readBody(req);
      const org = typeof body.org === "string" ? body.org.trim() : "";
      if (!org) return send(res, 400, { error: "org is required" });
      return send(res, 200, rememberGithubOrg(org));
    }
  }
  if (parts[0] === "github" && parts[1] === "repos" && parts.length === 2 && method === "GET") {
    const org = (url.searchParams.get("org") ?? "").trim();
    if (!org) return send(res, 400, { error: "org is required" });
    setLastGithubOrg(org);
    const cached = readReposCache(org);
    const refresh = url.searchParams.get("refresh") === "1";
    if (cached && !refresh) return send(res, 200, { org, repos: cached.repos, fetchedAt: cached.fetchedAt, cached: true });
    try {
      const repos = await fetchOrgRepos(org);
      writeReposCache(org, repos);
      return send(res, 200, { org, repos, fetchedAt: new Date().toISOString(), cached: false });
    } catch (err) {
      if (cached) return send(res, 200, { org, repos: cached.repos, fetchedAt: cached.fetchedAt, cached: true, stale: true, error: String(err) });
      return send(res, 400, { error: `gh repo list failed: ${String(err)}` });
    }
  }
  // /api/github/issues?repo=owner/name — open issues for a repo (live via gh).
  if (parts[0] === "github" && parts[1] === "issues" && parts.length === 2 && method === "GET") {
    const repo = (url.searchParams.get("repo") ?? "").trim();
    if (!repo) return send(res, 400, { error: "repo is required" });
    try {
      return send(res, 200, { repo, issues: await fetchIssues(repo) });
    } catch (err) {
      return send(res, 400, { error: `gh issue list failed: ${String(err)}` });
    }
  }
  // /api/github/default-branch?repo=owner/name — the repo's default branch, so the
  // console seeds "Base branch" with the real default instead of assuming main.
  if (parts[0] === "github" && parts[1] === "default-branch" && parts.length === 2 && method === "GET") {
    const repo = (url.searchParams.get("repo") ?? "").trim();
    if (!repo) return send(res, 400, { error: "repo is required" });
    try {
      return send(res, 200, { repo, defaultBranch: await fetchDefaultBranch(repo) });
    } catch (err) {
      return send(res, 400, { error: `gh repo view failed: ${String(err)}` });
    }
  }

  // /api/conversations
  if (parts[0] === "conversations" && parts.length === 1) {
    if (method === "GET") return send(res, 200, list(principal.id));
    if (method === "POST") {
      const body = await readBody(req);
      const requestedTarget = body["target"] as Target;
      const target = body["createNewBranch"] === true
        ? { ...requestedTarget, newBranch: await generateBranchName(String(body["branchPrompt"] ?? body["title"] ?? "agent change")) }
        : requestedTarget;
      if (identity.kind === "hosted" && target?.kind !== "remote") {
        return send(res, 400, { error: "hosted conversations require a remote GitHub target" });
      }
      return send(res, 201, createConversation(principal.id, { title: String(body["title"] ?? "untitled"), target }));
    }
  }

  // /api/conversations/:id  and  /:id/timeline  and  /:id/sessions
  if (parts[0] === "conversations" && parts[1]) {
    const convId = parts[1];
    if (parts.length === 2 && method === "GET") {
      const rendered = renderConversation(principal.id, convId);
      return rendered ? send(res, 200, rendered) : send(res, 404, { error: "not found" });
    }
    if (parts[2] === "timeline" && method === "GET") {
      if (!getOwnedConversation(convId, principal.id)) return send(res, 404, { error: "not found" });
      const anchor = url.searchParams.get("anchor") === "session" ? "session" : "conversation";
      return send(res, 200, buildTimeline(convId, anchor));
    }
    if (parts[2] === "sessions" && method === "POST") {
      const body = (await readBody(req)) as unknown as StartSessionInput;
      try {
        if (identity.kind === "hosted" && body.settings?.backend !== "daytona") {
          return send(res, 400, { error: "hosted sessions require the Daytona backend" });
        }
        // Resolve the principal's credentials through the identity seam and pass
        // them into the run — never from the request body (secrets aren't
        // client-supplied). The principal is guaranteed by the gate above.
        const conversation = getOwnedConversation(convId, principal.id);
        if (!conversation) return send(res, 404, { error: "not found" });
        const remoteRepo = conversation.target.kind === "remote" ? conversation.target.repo : undefined;
        const credentials =
          identity instanceof HostedIdentity && remoteRepo
            ? await identity.resolveCredentialsForRepo(principal, remoteRepo)
            : await identity.resolveCredentials(principal);
        const refreshCredentials =
          identity instanceof HostedIdentity && remoteRepo
            ? () => identity.resolveCredentialsForRepo(principal, remoteRepo)
            : undefined;
        return send(res, 202, startSession(principal.id, convId, body, credentials, refreshCredentials));
      } catch (err) {
        if (err instanceof AtCapacityError) return send(res, 429, { error: err.message });
        return send(res, 400, { error: String(err) });
      }
    }
    if (parts[2] === "sessions" && parts[3] && parts[4] === "stop" && method === "POST") {
      return send(res, 501, { error: "session stop is not implemented yet" });
    }
    // /:id/sessions/:sid/artifacts/:name — a file the runner pulled out of the
    // backend (e.g. a QA screenshot). Served from the session dir; name is
    // sanitized to its basename so it can't escape the artifacts folder.
    if (parts[2] === "sessions" && parts[3] && parts[4] === "artifacts" && parts[5] && method === "GET") {
      if (!getOwnedConversation(convId, principal.id)) return send(res, 404, { error: "not found" });
      const name = basename(parts[5]);
      const path = join(sessionDir(convId, parts[3]), "artifacts", name);
      if (!existsSync(path)) return send(res, 404, { error: "not found" });
      return sendFile(res, path);
    }
  }

  send(res, 404, { error: "no route", path: url.pathname });
}

export function startServer(port: number): ReturnType<typeof createServer> {
  const server = createServer((req, res) => {
    route(req, res).catch((err) => send(res, 500, { error: String(err) }));
  });
  server.listen(port, () => {
    process.stdout.write(`orchestrator API on http://localhost:${port}\n`);
    if (!(identity instanceof HostedIdentity)) logAuthStatus((line) => process.stdout.write(line));
    identity.logStatus((line) => process.stdout.write(line));
    if (identity instanceof HostedIdentity) {
      void identity.ready
        .then(() => process.stdout.write("hosted identity database ready\n"))
        .catch((error) => {
          process.stderr.write(`hosted identity database failed: ${String(error)}\n`);
          server.close(() => {
            void identity.close().finally(() => {
              process.exitCode = 1;
            });
          });
        });
    }
  });
  return server;
}
