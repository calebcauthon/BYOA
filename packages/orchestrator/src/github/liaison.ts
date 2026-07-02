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
  /** Expected owner/name for remote targets; guards against pushing a stale or incorrect checkout. */
  repo?: string;
  /** PR base branch; defaults to the repo's default branch when omitted. */
  base?: string;
  result: AgentResult;
}

export interface PublishOutcome {
  pushed: boolean;
  branchUrl?: string;
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

  const slug = await slugFrom(ctx, log);
  if (!slug) {
    log.emit("orchestrator", "info", "publish skipped: checkout has no github origin");
    return { pushed: false, commentsPosted: 0, skipped: "no-origin" };
  }
  if (ctx.repo && slug.toLowerCase() !== ctx.repo.toLowerCase()) {
    log.emit("orchestrator", "error", `publish blocked: checkout origin is ${slug}, but run target is ${ctx.repo}`);
    return { pushed: false, commentsPosted: 0, skipped: "origin-mismatch" };
  }
  const branchUrl = `https://github.com/${slug}/tree/${branch.split("/").map(encodeURIComponent).join("/")}`;

  const base = ctx.base || (await host("gh", ["repo", "view", slug, "--json", "defaultBranchRef", "-q", ".defaultBranchRef.name"])).stdout || "master";

  // Agents are instructed to commit, but publishing must not depend on prompt
  // compliance. Capture any remaining working-tree changes before the ephemeral
  // backend is disposed, then use git history—not the provider's `changed`
  // flag—as the source of truth for whether a PR can exist.
  const status = await backend.exec(
    ["git", "status", "--porcelain"],
    { cwd: workdir, source: "orchestrator", logStdout: false },
    log,
  );
  if (status.exitCode !== 0) {
    log.emit("orchestrator", "error", "publish: could not inspect working tree");
    return { pushed: false, commentsPosted: 0, skipped: "status-failed" };
  }
  if (status.stdout.trim()) {
    log.emit("orchestrator", "info", "publish: committing remaining agent changes");
    const add = await backend.exec(["git", "add", "-A"], { cwd: workdir, source: "orchestrator" }, log);
    if (add.exitCode !== 0) return { pushed: false, commentsPosted: 0, skipped: "commit-failed" };
    const commit = await backend.exec(
      [
        "git",
        "-c",
        "user.name=automations agent",
        "-c",
        "user.email=agent@automations.local",
        "commit",
        "-m",
        `agent: ${branch}`,
      ],
      { cwd: workdir, source: "orchestrator" },
      log,
    );
    if (commit.exitCode !== 0) {
      log.emit("orchestrator", "error", `publish: commit failed: ${(commit.stderr || commit.stdout).slice(-400)}`);
      return { pushed: false, commentsPosted: 0, skipped: "commit-failed" };
    }
  }

  const comparisonBase = base === branch ? `origin/${base}` : base;
  const ahead = await backend.exec(
    ["git", "rev-list", "--count", `${comparisonBase}..HEAD`],
    { cwd: workdir, source: "orchestrator", logStdout: false },
    log,
  );
  const commitsAhead = Number.parseInt(ahead.stdout.trim(), 10);
  if (ahead.exitCode !== 0 || !Number.isFinite(commitsAhead)) {
    log.emit("orchestrator", "error", `publish: could not compare HEAD with base ${base}`);
    return { pushed: false, commentsPosted: 0, skipped: "compare-failed" };
  }
  if (commitsAhead === 0) {
    log.emit("orchestrator", "info", `publish skipped: no commits between ${comparisonBase} and ${branch}`);
    return { pushed: false, commentsPosted: 0, skipped: "no-change" };
  }

  // 1) push — through the backend, from wherever the commits are. One-shot token
  // URL (no token persisted in .git/config); token redacted from logs.
  const token = (await host("gh", ["auth", "token"])).stdout.trim();
  if (!token) {
    log.emit("orchestrator", "error", "publish: no gh token (gh auth token)");
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
  if (base === branch) {
    log.emit("orchestrator", "info", `publish: pushed ${branch}; no PR (head equals base ${base} — enable "create a new branch" to open one)`);
    return { pushed: true, branchUrl, commentsPosted: 0, skipped: "head-equals-base" };
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
      return { pushed: true, branchUrl, commentsPosted: 0, skipped: "pr-failed" };
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

  return { pushed: true, branchUrl, ...(prUrl ? { prUrl } : {}), commentsPosted };
}
