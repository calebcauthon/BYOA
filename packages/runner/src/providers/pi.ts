/**
 * pi provider — drives the `pi` coding agent inside the backend.
 *
 * Mirrors the prototype's invocation (agentloop/sandbox.py):
 *   pi -p --provider openrouter --model <model> --session-dir <dir>   < prompt
 * with OPENROUTER_API_KEY in the env. pi reads the prompt on stdin, edits the
 * working tree (and may make its own commits), and writes a session JSONL under
 * --session-dir keyed by cwd.
 *
 * What this provider adds over a raw exec: it captures that JSONL and re-emits
 * every block (thinking / text / tool call / tool result) as `agent`-source log
 * lines, so the transcript is a first-class log source (§3.2), not a scraped
 * file. It also detects whether work happened via HEAD-before/after + dirty tree.
 *
 * Note: `pi`'s `--provider` (the LLM gateway, openrouter) is distinct from our
 * AgentSessionSettings.provider (the agent program, "pi"). M1 hardwires
 * openrouter; the model comes from settings.model.
 */
import { readdirSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Blackboard } from "@automations/core";
import { registerProvider, type Provider, type ProviderRunInput } from "./index.ts";
import type { Backend, ExecOpts } from "../backends/index.ts";
import type { SessionLog } from "../logging.ts";

const PI_TIMEOUT_MS = Number(process.env.RUNNER_PI_TIMEOUT_MS ?? 30 * 60 * 1000);
const HEARTBEAT_MS = 30 * 1000;

async function gitHead(backend: Backend, cwd: string, log: SessionLog): Promise<string> {
  const r = await backend.exec(["git", "rev-parse", "HEAD"], { cwd }, log);
  return r.exitCode === 0 ? r.stdout.trim() : "";
}

class PiProvider implements Provider {
  readonly kind = "pi";

  async run({ settings, backend, workdir, prompt, sessionDir, clockOffsetMs, log }: ProviderRunInput): Promise<Blackboard> {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) throw new Error("OPENROUTER_API_KEY is not set");
    mkdirSync(sessionDir, { recursive: true });

    const headBefore = await gitHead(backend, workdir, log);
    log.emit("agent", "info", `pi starting (model=${settings.model}, agent=${settings.agent})`, {
      headBefore,
    });

    const cmd = [
      "pi",
      "-p",
      "--provider",
      "openrouter",
      "--model",
      settings.model,
      "--session-dir",
      sessionDir,
    ];
    const opts: ExecOpts = {
      cwd: workdir,
      input: prompt,
      env: { OPENROUTER_API_KEY: key },
      timeoutMs: PI_TIMEOUT_MS,
      heartbeatMs: HEARTBEAT_MS,
      source: "agent", // pi IS the agent program; its raw stream is an agent log
    };

    const res = await backend.exec(cmd, opts, log);

    const sessionFile = this.emitTranscript(sessionDir, log, clockOffsetMs);

    if (res.exitCode !== 0) {
      throw new Error(
        res.timedOut ? "pi timed out" : `pi failed (exit ${res.exitCode}): ${res.stderr.slice(-2000)}`,
      );
    }

    const headAfter = await gitHead(backend, workdir, log);
    const porcelain = (await backend.exec(["git", "status", "--porcelain"], { cwd: workdir }, log)).stdout.trim();
    const changed = headAfter !== headBefore || porcelain.length > 0;
    log.emit("agent", "info", `pi finished (changed=${changed})`, { headBefore, headAfter });

    return {
      [settings.agent]: {
        changed,
        headBefore,
        headAfter,
        uncommitted: porcelain.length > 0,
        sessionFile,
      },
    };
  }

  /** Normalize a pi-clock ISO timestamp onto the host timeline. */
  private hostTs(raw: unknown, offsetMs: number): string | undefined {
    if (typeof raw !== "string") return undefined;
    const ms = Date.parse(raw);
    if (Number.isNaN(ms)) return undefined;
    return new Date(ms + offsetMs).toISOString();
  }

  /** Find the pi session JSONL and stream each block out as `agent` log lines,
   *  each stamped with pi's REAL recorded time (offset to host clock) so the
   *  unified timeline preserves real-life order. */
  private emitTranscript(sessionDir: string, log: SessionLog, offsetMs: number): string | null {
    let files: string[] = [];
    try {
      files = readdirSync(sessionDir, { recursive: true, encoding: "utf8" }).filter((f) =>
        f.endsWith(".jsonl"),
      );
    } catch {
      /* none */
    }
    if (files.length === 0) {
      log.emit("agent", "warn", "no pi session jsonl found to capture");
      return null;
    }
    const rel = files[0]!;
    const path = join(sessionDir, rel);
    let lines: string[] = [];
    try {
      lines = readFileSync(path, "utf8").split("\n");
    } catch {
      return null;
    }

    let seenFirstUser = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (obj["type"] !== "message") continue;
      const msg = (obj["message"] ?? {}) as Record<string, unknown>;
      const role = msg["role"];
      const content = msg["content"];
      if (!Array.isArray(content)) continue;
      // pi's real recording time for this message, normalized to the host clock.
      const ts = this.hostTs(obj["timestamp"], offsetMs);

      if (role === "user") {
        // First user message is the prompt we already have; skip it.
        if (!seenFirstUser) {
          seenFirstUser = true;
          continue;
        }
        const text = this.blocksText(content);
        if (text) log.emit("agent", "info", text, { kind: "user" }, ts);
      } else if (role === "assistant") {
        for (const block of content) {
          if (typeof block !== "object" || block === null) continue;
          const b = block as Record<string, unknown>;
          if (b["type"] === "thinking" && b["thinking"]) {
            log.emit("agent", "debug", String(b["thinking"]).trim(), { kind: "thinking" }, ts);
          } else if (b["type"] === "text" && b["text"]) {
            log.emit("agent", "info", String(b["text"]).trim(), { kind: "assistant" }, ts);
          } else if (b["type"] === "toolCall") {
            log.emit(
              "agent",
              "info",
              `→ ${String(b["name"] ?? "tool")}`,
              { kind: "tool-call", tool: b["name"], arguments: b["arguments"] },
              ts,
            );
          }
        }
      } else if (role === "toolResult") {
        log.emit(
          "agent",
          "info",
          `← ${String(msg["toolName"] ?? "tool")}`,
          { kind: "tool-result", tool: msg["toolName"], text: this.blocksText(content).slice(0, 2000) },
          ts,
        );
      }
    }
    return path;
  }

  private blocksText(content: unknown[]): string {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === "object" && block !== null) {
        const b = block as Record<string, unknown>;
        if (b["type"] === "text" && b["text"]) parts.push(String(b["text"]).trim());
      }
    }
    return parts.filter(Boolean).join("\n\n");
  }
}

registerProvider("pi", () => new PiProvider());
