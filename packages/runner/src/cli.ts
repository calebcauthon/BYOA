#!/usr/bin/env node
/**
 * agent-session — standalone CLI to run ONE Agent Session.
 *
 * The whole point of this package: you can run an agent prompt by itself, against
 * any backend, with no orchestrator. Examples:
 *
 *   # local, dry-run (just resolve + print the plan)
 *   node packages/runner/src/cli.ts run \
 *     --provider pi --model anthropic/claude-opus-4.8 \
 *     --backend local --repo-path /path/to/repo --branch feat-x \
 *     --agent generic --prompt ./prompt.md --out ./.session --dry-run
 *
 *   # remote target
 *   node packages/runner/src/cli.ts run \
 *     --provider pi --model ... --backend sandbox \
 *     --repo owner/name --issue 12 --branch agent/issue-12 \
 *     --agent coder --prompt ./prompt.md --out ./.session
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSessionSettings, Target } from "@automations/core";
import { runSession } from "./session.ts";

function parseArgs(argv: string[]): Map<string, string | boolean> {
  const out = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (!tok.startsWith("--")) continue;
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out.set(key, true);
    } else {
      out.set(key, next);
      i++;
    }
  }
  return out;
}

function req(args: Map<string, string | boolean>, key: string): string {
  const v = args.get(key);
  if (typeof v !== "string") throw new Error(`missing required --${key}`);
  return v;
}

function buildTarget(args: Map<string, string | boolean>): Target {
  const branch = req(args, "branch");
  if (args.has("repo-path")) {
    return { kind: "local", repoPath: req(args, "repo-path"), branch };
  }
  const repo = req(args, "repo");
  const issueRaw = args.get("issue");
  return {
    kind: "remote",
    repo,
    branch,
    ...(typeof issueRaw === "string" ? { issue: Number(issueRaw) } : {}),
  };
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd !== "run") {
    process.stderr.write("usage: agent-session run [options]  (see header of cli.ts)\n");
    process.exit(cmd ? 1 : 0);
  }
  const args = parseArgs(rest);

  const settings: AgentSessionSettings = {
    backend: req(args, "backend") as AgentSessionSettings["backend"],
    provider: req(args, "provider") as AgentSessionSettings["provider"],
    model: req(args, "model"),
    agent: req(args, "agent"),
    target: buildTarget(args),
  };

  const promptPath = req(args, "prompt");
  const prompt = readFileSync(promptPath, "utf8");
  const outDir = (args.get("out") as string) || join(process.cwd(), ".session");
  const sessionId = `sess-${new Date().toISOString().replace(/[:.]/g, "-")}`;

  if (args.get("dry-run")) {
    process.stdout.write(
      JSON.stringify({ plan: "dry-run", sessionId, outDir, settings, promptBytes: prompt.length }, null, 2) + "\n",
    );
    return;
  }

  const result = await runSession({ sessionId, settings, prompt, outDir });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

main().catch((err) => {
  process.stderr.write(`agent-session: ${String(err)}\n`);
  process.exit(1);
});
