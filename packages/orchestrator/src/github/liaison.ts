/**
 * GitHub liaison (architecture §2.1, §4.4) — the ONLY thing that touches the
 * remote. Deterministic: it pushes the branch, auto-creates/updates the PR using
 * the agent-authored `pr-description`, and posts the agent-authored `comment`s.
 * The agent never pushes; it only authored what to say (in result.publish).
 *
 * Runs as the runner's afterWork hook — i.e. with the LIVE backend, before
 * dispose — so the push originates from wherever the commits actually are:
 *   • local/container → the host / bind-mounted repo
 *   • daytona         → inside the sandbox (the commits live there, not on host)
 * The push goes through `backend.exec` (adapter-clean), authed with a one-shot
 * token URL the orchestrator owns (`gh auth token`); the token is redacted from
 * logs and never written to .git/config. The GitHub API calls (PR, comment) are
 * host-side via `gh`.
 */
import { spawn } from "node:child_process";
import type { AgentResult, Publication } from "@automations/core";
import type { Backend, SessionLog } from "@automations/runner";

interface HostRun {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a host command (git/gh) capturing output. */
function host(bin: string, args: string[], input?: string): Promise<HostRun> {
  return new Promise((resolve) => {
    const child = spawn(bin, args);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim() }));
    child.on("error", (e) => resolve({ code: -1, stdout: "", stderr: String(e) }));
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

export interface PublishContext {
  backend: Backend;
  /** working tree path INSIDE the backend (host path for local; /workspace for daytona) */
  workdir: string;
  branch: string;
  /** PR base branch; defaults to the repo's default branch when omitted. */
  base?: string;
  /** the principal's GitHub token for the push; falls back to `gh auth token`
   *  (host CLI) when omitted, preserving single-operator local behavior. */
  token?: string;
  result: AgentResult;
}

export interface PublishOutcome {
  pushed: boolean;
  prUrl?: string;
  commentsPosted: number;
  skipped?: string;
}

function pubs<K extends Publication["kind"]>(list: Publication[], kind: K): Extract<Publication, { kind: K }>[] {
  return list.filter((p): p is Extract<Publication, { kind: K }> => p.kind === kind);
}

/** owner/name from the backend repo's origin remote (works wherever the repo is). */
async function slugFrom(ctx: PublishContext, log: SessionLog): Promise<string | null> {
  const r = await ctx.backend.exec(["git", "remote", "get-url", "origin"], { cwd: ctx.workdir }, log);
  if (r.exitCode !== 0) return null;
  const m = r.stdout.trim().match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\s*$/);
  return m ? m[1]! : null;
}

export async function publish(ctx: PublishContext, log: SessionLog): Promise<PublishOutcome> {
  const { backend, workdir, branch, result } = ctx;
  const list = result.publish ?? [];

  if (!result.changed) {
    log.emit("orchestrator", "info", "publish skipped: agent made no changes");
    return { pushed: false, commentsPosted: 0, skipped: "no-change" };
  }
  const slug = await slugFrom(ctx, log);
  if (!slug) {
    log.emit("orchestrator", "info", "publish skipped: checkout has no github origin");
    return { pushed: false, commentsPosted: 0, skipped: "no-origin" };
  }

  // 1) push — through the backend, from wherever the commits are. One-shot token
  // URL (no token persisted in .git/config); token redacted from logs. Prefer the
  // principal's token (GitHub App, hosted); fall back to the host `gh` CLI (local).
  const token = ctx.token || (await host("gh", ["auth", "token"])).stdout.trim();
  if (!token) {
    log.emit("orchestrator", "error", "publish: no github token (principal token or `gh auth token`)");
    return { pushed: false, commentsPosted: 0, skipped: "no-token" };
  }
  const authedUrl = `https://x-access-token:${token}@github.com/${slug}.git`;
  log.emit("orchestrator", "info", `pushing ${branch} → ${slug}`);
  const push = await backend.exec(
    ["git", "push", authedUrl, `HEAD:refs/heads/${branch}`],
    { cwd: workdir, source: "orchestrator", redact: [token, authedUrl] },
    log,
  );
  if (push.exitCode !== 0) {
    log.emit("orchestrator", "error", `git push failed: ${push.stdout.slice(-400)}`);
    return { pushed: false, commentsPosted: 0, skipped: "push-failed" };
  }

  // 2) ensure a draft PR; description from the agent's pr-description
  const base = ctx.base || (await host("gh", ["repo", "view", slug, "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"])).stdout || "master";
  if (base === branch) {
    log.emit("orchestrator", "info", `publish: pushed ${branch}; no PR (head equals base ${base} — enable "create a new branch" to open one)`);
    return { pushed: true, commentsPosted: 0, skipped: "head-equals-base" };
  }
  const desc = pubs(list, "pr-description")[0];
  const title = desc?.title || `agent: ${branch}`;
  const body = desc?.body || "_(no description provided by the agent)_";

  let prUrl: string | undefined;
  const existing = await host("gh", ["pr", "view", branch, "--repo", slug, "--json", "url", "-q", ".url"]);
  if (existing.code === 0 && existing.stdout) {
    prUrl = existing.stdout;
    log.emit("orchestrator", "info", `PR exists (${prUrl}); updating description`);
    await host("gh", ["pr", "edit", branch, "--repo", slug, "--title", title, "--body-file", "-"], body);
  } else {
    const create = await host(
      "gh",
      ["pr", "create", "--repo", slug, "--base", base, "--head", branch, "--draft", "--title", title, "--body-file", "-"],
      body,
    );
    if (create.code !== 0) {
      log.emit("orchestrator", "error", `gh pr create failed: ${create.stderr.slice(-400)}`);
      return { pushed: true, commentsPosted: 0, skipped: "pr-failed" };
    }
    prUrl = create.stdout.split("\n").pop();
    log.emit("orchestrator", "info", `opened draft PR ${prUrl}`);
  }

  // 3) post the agent-authored comments
  let commentsPosted = 0;
  for (const c of pubs(list, "comment")) {
    const r = await host("gh", ["pr", "comment", branch, "--repo", slug, "--body-file", "-"], c.body);
    if (r.code === 0) commentsPosted++;
    else log.emit("orchestrator", "warn", `comment failed: ${r.stderr.slice(-300)}`);
  }
  if (commentsPosted) log.emit("orchestrator", "info", `posted ${commentsPosted} comment(s) on the PR`);

  return { pushed: true, ...(prUrl ? { prUrl } : {}), commentsPosted };
}
