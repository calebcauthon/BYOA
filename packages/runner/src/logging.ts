/**
 * Source-tagged log writer (architecture.md §3.2).
 *
 * The runner is the thing that touches all four log sources, so it owns the
 * canonical writer. Every entry is datestamped + source-tagged. Streams are kept
 * SEPARATE on disk (one JSONL file per source) so a backend log is never tangled
 * into the agent transcript — but every line carries `ts`/`source` so the
 * orchestrator can read them all and render ONE unified, interleaved timeline.
 *
 * Self-contained on purpose: no runtime import of @automations/core, so the CLI
 * runs standalone under `node` type-stripping with zero install.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LogEntry, LogSource, LogLevel } from "@automations/core";

export class SessionLog {
  private readonly dir: string;
  private readonly sessionId: string;

  constructor(dir: string, sessionId: string) {
    this.dir = dir;
    this.sessionId = sessionId;
    mkdirSync(dir, { recursive: true });
  }

  /** One file per source: orchestrator.jsonl, backend.jsonl, agent.jsonl, … */
  private fileFor(source: LogSource): string {
    return join(this.dir, `${source}.jsonl`);
  }

  emit(
    source: LogSource,
    level: LogLevel,
    message: string,
    data?: Record<string, unknown>,
    /**
     * Real event time, normalized to the HOST clock. Pass this when re-emitting
     * something that happened earlier (e.g. a pi transcript block parsed after
     * the fact) so the unified timeline reflects real-life order, not parse time.
     * Defaults to now() for things happening live on the host.
     */
    ts?: string,
  ): void {
    const entry: LogEntry = {
      ts: ts ?? new Date().toISOString(),
      source,
      level,
      sessionId: this.sessionId,
      message,
      ...(data ? { data } : {}),
    };
    appendFileSync(this.fileFor(source), JSON.stringify(entry) + "\n", "utf8");
    // Also echo to stderr so a standalone run is observable in the terminal.
    process.stderr.write(`[${entry.ts}] ${source}/${level}: ${message}\n`);
  }
}
