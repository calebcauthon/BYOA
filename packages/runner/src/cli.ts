#!/usr/bin/env node
/**
 * agent-session — standalone CLI to run ONE Agent Session from a JSON spec.
 *
 * Usage:
 *   agent-session run <spec.json>     # path to a JSON spec file
 *   agent-session run '<json>'        # inline JSON string
 *   agent-session run                 # read JSON spec from stdin
 *   add --dry-run to resolve + print the plan without running.
 *
 * Spec shape (see SessionSpec):
 *   {
 *     "backend":  "local" | "container" | "sandbox",
 *     "provider": "pi" | "claude-subscription" | "codex",
 *     "model":    "anthropic/claude-opus-4.8",
 *     "agent":    "generic",
 *     "target":   { "kind": "local",  "repoPath": "/path/to/repo", "branch": "feat-x" }
 *               | { "kind": "remote", "repo": "owner/name", "issue": 12, "branch": "agent/issue-12" },
 *     "prompt":   "…inline prompt…",        // OR
 *     "promptFile": "./prompt.md",
 *     "out":      "./.session",             // optional; defaults to ./.session
 *     "dryRun":   false                     // optional
 *   }
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentSessionSettings, IgnoreKind, Target } from "@automations/core";
import { runSession } from "./session.ts";
import { writeTimeline } from "./timeline.ts";

interface SessionSpec {
  backend: AgentSessionSettings["backend"];
  provider: AgentSessionSettings["provider"];
  model: string;
  agent: string;
  target: Target;
  carryContext?: string;
  /** ignore files to respect when copying the workspace to a backend (daytona) */
  respectIgnore?: IgnoreKind[];
  prompt?: string;
  promptFile?: string;
  out?: string;
  dryRun?: boolean;
}

function readSpec(arg: string | undefined): SessionSpec {
  let text: string;
  if (arg === undefined || arg === "-") {
    text = readFileSync(0, "utf8"); // stdin
  } else if (arg.trimStart().startsWith("{")) {
    text = arg; // inline JSON
  } else {
    text = readFileSync(arg, "utf8"); // file path
  }
  return JSON.parse(text) as SessionSpec;
}

function required<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === null) throw new Error(`spec is missing "${name}"`);
  return value;
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);

  // `timeline <session-dir>` — (re)derive the sorted, readable timeline.log from
  // a session's per-source logs. Runs automatically at the end of every session;
  // this command lets you regenerate it on any out dir.
  if (cmd === "timeline") {
    const dir = rest.find((a) => !a.startsWith("--"));
    if (!dir) {
      process.stderr.write("usage: agent-session timeline <session-out-dir>\n");
      process.exit(1);
    }
    const { file, count } = writeTimeline(dir);
    process.stdout.write(`wrote ${file} (${count} entries)\n`);
    return;
  }

  if (cmd !== "run") {
    process.stderr.write(
      "usage:\n  agent-session run <spec.json | '{…}' | - > [--dry-run]\n  agent-session timeline <session-out-dir>\n",
    );
    process.exit(cmd ? 1 : 0);
  }

  const flags = rest.filter((a) => a.startsWith("--"));
  const positional = rest.find((a) => !a.startsWith("--"));
  const spec = readSpec(positional);

  const settings: AgentSessionSettings = {
    backend: required(spec.backend, "backend"),
    provider: required(spec.provider, "provider"),
    model: required(spec.model, "model"),
    agent: required(spec.agent, "agent"),
    target: required(spec.target, "target"),
    ...(spec.carryContext !== undefined ? { carryContext: spec.carryContext } : {}),
    ...(spec.respectIgnore !== undefined ? { respectIgnore: spec.respectIgnore } : {}),
  };

  const prompt = spec.prompt ?? (spec.promptFile ? readFileSync(spec.promptFile, "utf8") : undefined);
  required(prompt, 'prompt" or "promptFile');

  const outDir = spec.out ?? join(process.cwd(), ".session");
  const sessionId = `sess-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const dryRun = spec.dryRun || flags.includes("--dry-run");

  if (dryRun) {
    process.stdout.write(
      JSON.stringify({ plan: "dry-run", sessionId, outDir, settings, promptBytes: prompt!.length }, null, 2) + "\n",
    );
    return;
  }

  const result = await runSession({ sessionId, settings, prompt: prompt!, outDir });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

main().catch((err) => {
  process.stderr.write(`agent-session: ${String(err)}\n`);
  process.exit(1);
});
