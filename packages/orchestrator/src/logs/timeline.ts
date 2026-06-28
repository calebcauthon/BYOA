/**
 * Render a Conversation's logs as ONE unified, interleaved timeline (§3.2).
 *
 * The runner wrote logs SEPARATED by source (one JSONL per source, per session).
 * Rendering is the orchestrator's job alone: we read every source file across
 * every session in the conversation and interleave by timestamp — without losing
 * provenance (each entry keeps its `source` and `sessionId`).
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { LogEntry, LogSource } from "@automations/core";
import { sessionsDir } from "../state/store.ts";

const SOURCES: LogSource[] = ["orchestrator", "backend", "agent", "workload", "workflow"];

function readSource(dir: string, source: LogSource, sessionId: string): LogEntry[] {
  const path = join(dir, `${source}.jsonl`);
  if (!existsSync(path)) return [];
  const out: LogEntry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as LogEntry;
      // sessionId is written by the runner, but backfill it for safety.
      out.push({ ...entry, sessionId: entry.sessionId ?? sessionId });
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

/** All log entries for a conversation, interleaved by timestamp. */
export function buildTimeline(convId: string): LogEntry[] {
  const base = sessionsDir(convId);
  if (!existsSync(base)) return [];
  const entries: LogEntry[] = [];
  for (const sid of readdirSync(base)) {
    const dir = join(base, sid);
    for (const source of SOURCES) {
      entries.push(...readSource(dir, source, sid));
    }
  }
  entries.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return entries;
}
