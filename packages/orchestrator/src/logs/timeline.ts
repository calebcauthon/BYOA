/**
 * Render a Conversation's logs as ONE unified, interleaved timeline (§3.2).
 *
 * The runner wrote logs SEPARATED by source (one JSONL per source, per session).
 * Rendering is the orchestrator's job alone: we read every source file across
 * every session in the conversation and interleave by timestamp — without losing
 * provenance (each entry keeps its `source` and `sessionId`).
 *
 * Absolute real timestamps (already normalized to the host clock by the runner)
 * are the source of truth. On top of that we anchor a single **t=0** at the first
 * event so the whole conversation reads relatively (`+0.000s`, `+2.768s, …`),
 * which is what a reader/UI actually wants. The anchor is derived, never stored.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { LogEntry, LogSource } from "@automations/core";
import { sessionsDir } from "../state/store.ts";

const SOURCES: LogSource[] = ["orchestrator", "backend", "agent", "workload", "workflow"];

/** A timeline entry: the raw log line plus its offset from the shared t=0. */
export interface TimelineEntry extends LogEntry {
  /** milliseconds since the timeline's t=0 (the first event) */
  relMs: number;
  /** human label, e.g. "+2.768s" */
  rel: string;
}

export interface Timeline {
  /** the shared zero — ISO timestamp of the first event (null if empty) */
  t0: string | null;
  entries: TimelineEntry[];
}

function readSource(dir: string, source: LogSource, sessionId: string): LogEntry[] {
  const path = join(dir, `${source}.jsonl`);
  if (!existsSync(path)) return [];
  const out: LogEntry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as LogEntry;
      out.push({ ...entry, sessionId: entry.sessionId ?? sessionId });
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

function fmtRel(ms: number): string {
  const sign = ms < 0 ? "-" : "+";
  return `${sign}${(Math.abs(ms) / 1000).toFixed(3)}s`;
}

/**
 * All log entries for a conversation, interleaved by real timestamp and anchored
 * to a shared t=0.
 * @param anchor "conversation" (default) zeroes at the conversation's first event;
 *               "session" zeroes each session at its own first event.
 */
export function buildTimeline(convId: string, anchor: "conversation" | "session" = "conversation"): Timeline {
  const base = sessionsDir(convId);
  if (!existsSync(base)) return { t0: null, entries: [] };

  const raw: LogEntry[] = [];
  for (const sid of readdirSync(base)) {
    const dir = join(base, sid);
    for (const source of SOURCES) raw.push(...readSource(dir, source, sid));
  }
  raw.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  if (raw.length === 0) return { t0: null, entries: [] };

  // Per-session anchors (first event seen per session) for "session" mode.
  const sessionT0 = new Map<string, number>();
  if (anchor === "session") {
    for (const e of raw) {
      const sid = e.sessionId ?? "";
      if (!sessionT0.has(sid)) sessionT0.set(sid, Date.parse(e.ts));
    }
  }
  const convT0 = Date.parse(raw[0]!.ts);

  const entries: TimelineEntry[] = raw.map((e) => {
    const zero = anchor === "session" ? (sessionT0.get(e.sessionId ?? "") ?? convT0) : convT0;
    const relMs = Date.parse(e.ts) - zero;
    return { ...e, relMs, rel: fmtRel(relMs) };
  });

  return { t0: raw[0]!.ts, entries };
}
