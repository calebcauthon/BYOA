/**
 * GitHub liaison (architecture §2.1, §4.4) — the ONLY thing that touches the
 * remote. Deterministic: it pushes the branch, auto-creates/updates the PR using
 * the agent-authored `pr-description`, and posts the agent-authored `comment`s.
 * The agent never pushes; it only authored what to say (in result.publish).
 *
 * Uses the `gh` CLI (already authenticated) for API calls and `git` for the push.
 * M3 scope: works for a LOCAL checkout that has a GitHub `origin` (local/container
 * backends — commits are on the host repo). Daytona push-from-sandbox is a later
 * slice.
 */
import { spawn } from "node:child_process";
import type { AgentResult, LogLevel, LogSource, Publication } from "@automations/core";

/** Minimal logger the liaison needs — the runner's SessionLog satisfies it. */
export interface Logger {
  emit(source: LogSource, level: LogLevel, message: string, data?: Record<string, unknown>): void;
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function run(bin: string, args: string[], opts: { cwd?: string; input?: string } = {}): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, opts.cwd ? { cwd: opts.cwd } : {});
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim() }));
    child.on("error", (e) => resolve({ code: -1, stdout: "", stderr: String(e) }));
    if (opts.input !== undefined) child.stdin.write(opts.input);
    child.stdin.end();
  });
}

/** owner/name from the repo's origin remote, or null if there isn't one. */
async function originSlug(repoPath: string): Promise<string | null> {
  const r = await run("git", ["-C", repoPath, "remote", "get-url", "origin"]);
  if (r.code !== 0) return null;
  const m = r.stdout.match(/github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?$/);
  return m ? m[1]! : null;
}

export interface PublishContext {
  repoPath: string;
  branch: string;
  /** the agent's standardized result; we read result.publish */
  result: AgentResult;
}

export interface PublishOutcome {
  pushed: boolean;
  prUrl?: string;
  commentsPosted: number;
  skipped?: string;
}

function find(pubs: Publication[], kind: Publication["kind"]): Publication[] {
  return pubs.filter((p) => p.kind === kind);
}

/** Push the branch, ensure a draft PR (body from pr-description), post comments. */
export async function publish(ctx: PublishContext, log: Logger): Promise<PublishOutcome> {
  const { repoPath, branch, result } = ctx;
  const pubs = result.publish ?? [];

  const slug = await originSlug(repoPath);
  if (!slug) {
    log.emit("orchestrator", "info", "publish skipped: no github origin on the checkout");
    return { pushed: false, commentsPosted: 0, skipped: "no-origin" };
  }

  // 1) push (deterministic) — the orchestrator owns the remote
  log.emit("orchestrator", "info", `pushing ${branch} → ${slug}`);
  const push = await run("git", ["-C", repoPath, "push", "-u", "origin", branch]);
  if (push.code !== 0) {
    log.emit("orchestrator", "error", `git push failed: ${push.stderr.slice(-500)}`);
    return { pushed: false, commentsPosted: 0, skipped: "push-failed" };
  }

  // 2) ensure a draft PR; body comes from the agent's pr-description
  const base = (await run("gh", ["repo", "view", slug, "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"])).stdout || "master";
  const desc = find(pubs, "pr-description")[0] as Extract<Publication, { kind: "pr-description" }> | undefined;
  const title = desc?.title || `agent: ${branch}`;
  const body = desc?.body || "_(no description provided by the agent)_";

  let prUrl: string | undefined;
  const existing = await run("gh", ["pr", "view", branch, "--repo", slug, "--json", "url", "-q", ".url"]);
  if (existing.code === 0 && existing.stdout) {
    prUrl = existing.stdout;
    log.emit("orchestrator", "info", `PR exists (${prUrl}); updating description`);
    await run("gh", ["pr", "edit", branch, "--repo", slug, "--title", title, "--body-file", "-"], { input: body });
  } else {
    const create = await run(
      "gh",
      ["pr", "create", "--repo", slug, "--base", base, "--head", branch, "--draft", "--title", title, "--body-file", "-"],
      { input: body },
    );
    if (create.code !== 0) {
      log.emit("orchestrator", "error", `gh pr create failed: ${create.stderr.slice(-500)}`);
      return { pushed: true, commentsPosted: 0, skipped: "pr-failed" };
    }
    prUrl = create.stdout.split("\n").pop();
    log.emit("orchestrator", "info", `opened draft PR ${prUrl}`);
  }

  // 3) post the agent-authored comments (template the PR URL in)
  let commentsPosted = 0;
  for (const c of find(pubs, "comment") as Extract<Publication, { kind: "comment" }>[]) {
    const r = await run("gh", ["pr", "comment", branch, "--repo", slug, "--body-file", "-"], { input: c.body });
    if (r.code === 0) {
      commentsPosted++;
      log.emit("orchestrator", "info", `posted comment on PR`);
    } else {
      log.emit("orchestrator", "warn", `comment failed: ${r.stderr.slice(-300)}`);
    }
  }

  return { pushed: true, ...(prUrl ? { prUrl } : {}), commentsPosted };
}
