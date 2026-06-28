/**
 * claude-subscription provider — drives the `claude` (Claude Code) CLI headless,
 * on the user's logged-in subscription, instead of pi-via-OpenRouter.
 *
 *   claude -p <prompt> --output-format stream-json --verbose \
 *          --dangerously-skip-permissions --model <model>
 *
 * Unlike pi (which writes a session JSONL with its own timestamps that we read
 * back and clock-normalize), claude's stream-json carries NO per-event timestamp.
 * So we parse the event stream **as it arrives** (ExecOpts.onStdout) and stamp
 * each emitted line at host-arrival time — which is already real host time, so no
 * clock offset is needed. Result: a live `agent`-source transcript on the unified
 * timeline.
 *
 * `--dangerously-skip-permissions` is required for headless edits/commits; this
 * only ever runs in an already-untrusted edit context (bare-metal or container —
 * see architecture §2.2).
 *
 * NOTE: for this provider, spec.model is a Claude Code model id (e.g.
 * "claude-haiku-4-5", "sonnet", "opus") — NOT the OpenRouter "anthropic/…" form
 * that the pi provider uses.
 */
import type { Blackboard } from "@automations/core";
import { registerProvider, type Provider, type ProviderRunInput } from "./index.ts";
import type { Backend, ExecOpts } from "../backends/index.ts";
import type { SessionLog } from "../logging.ts";

const CLAUDE_TIMEOUT_MS = Number(process.env.RUNNER_CLAUDE_TIMEOUT_MS ?? 30 * 60 * 1000);
const HEARTBEAT_MS = 30 * 1000;

async function gitHead(backend: Backend, cwd: string, log: SessionLog): Promise<string> {
  const r = await backend.exec(["git", "rev-parse", "HEAD"], { cwd }, log);
  return r.exitCode === 0 ? r.stdout.trim() : "";
}

class ClaudeProvider implements Provider {
  readonly kind = "claude-subscription";

  async run({ settings, backend, workdir, prompt, log }: ProviderRunInput): Promise<Blackboard> {
    const headBefore = await gitHead(backend, workdir, log);
    log.emit("agent", "info", `claude starting (model=${settings.model}, agent=${settings.agent})`, { headBefore });

    let costUsd: number | undefined;
    let isError = false;
    let buffer = "";
    const onLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        return; // not a JSON event line
      }
      this.emitEvent(ev, log);
      if (ev["type"] === "result") {
        costUsd = typeof ev["total_cost_usd"] === "number" ? (ev["total_cost_usd"] as number) : undefined;
        isError = ev["is_error"] === true;
      }
    };
    const onStdout = (chunk: string): void => {
      buffer += chunk;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        onLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    };

    const cmd = [
      "claude",
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--dangerously-skip-permissions",
      "--model",
      settings.model,
    ];
    const opts: ExecOpts = {
      cwd: workdir,
      timeoutMs: CLAUDE_TIMEOUT_MS,
      heartbeatMs: HEARTBEAT_MS,
      source: "agent",
      onStdout,
      logStdout: false, // we emit parsed events; don't double-log raw stream-json
    };

    const res = await backend.exec(cmd, opts, log);
    if (buffer.trim()) onLine(buffer); // flush any trailing partial line

    if (res.exitCode !== 0 || isError) {
      throw new Error(res.timedOut ? "claude timed out" : `claude failed (exit ${res.exitCode}): ${res.stderr.slice(-2000)}`);
    }

    const headAfter = await gitHead(backend, workdir, log);
    const porcelain = (await backend.exec(["git", "status", "--porcelain"], { cwd: workdir }, log)).stdout.trim();
    const changed = headAfter !== headBefore || porcelain.length > 0;
    log.emit("agent", "info", `claude finished (changed=${changed}${costUsd !== undefined ? `, cost $${costUsd.toFixed(4)}` : ""})`, {
      headBefore,
      headAfter,
      costUsd,
    });

    return {
      [settings.agent]: { changed, headBefore, headAfter, uncommitted: porcelain.length > 0, costUsd },
    };
  }

  /** Map one stream-json event to `agent`-source log lines (stamped at arrival). */
  private emitEvent(ev: Record<string, unknown>, log: SessionLog): void {
    const type = ev["type"];
    if (type === "assistant" || type === "user") {
      const msg = (ev["message"] ?? {}) as Record<string, unknown>;
      const content = msg["content"];
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as Record<string, unknown>;
        switch (b["type"]) {
          case "thinking":
            if (b["thinking"]) log.emit("agent", "debug", String(b["thinking"]).trim(), { kind: "thinking" });
            break;
          case "text":
            if (b["text"]) log.emit("agent", "info", String(b["text"]).trim(), { kind: "assistant" });
            break;
          case "tool_use":
            log.emit("agent", "info", `→ ${String(b["name"] ?? "tool")}`, {
              kind: "tool-call",
              tool: b["name"],
              arguments: b["input"],
            });
            break;
          case "tool_result": {
            const c = b["content"];
            const text = typeof c === "string" ? c : JSON.stringify(c);
            log.emit("agent", "info", `← tool`, { kind: "tool-result", text: text.slice(0, 2000) });
            break;
          }
        }
      }
    }
    // system / rate_limit / token-estimate events are intentionally dropped.
  }
}

registerProvider("claude-subscription", () => new ClaudeProvider());
