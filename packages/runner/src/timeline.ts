/**
 * Derive a single chronological file from a session's per-source logs.
 *
 * The per-source *.jsonl files are append-order (the faithful record of when we
 * learned about each event). This merges them and sorts by real `ts` into one
 * readable `timeline.log` — so you get BOTH: arrival-order raw files, and one
 * sorted timeline. Nothing is rewritten; the timeline is purely derived and can
 * be regenerated any time from the raw files.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { LogEntry, LogSource } from "@automations/core";

const SOURCES: LogSource[] = ["orchestrator", "backend", "agent", "workload", "workflow"];

/** Read every per-source log file in a session out dir, merged + sorted by ts. */
export function buildSessionTimeline(outDir: string): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const source of SOURCES) {
    const path = join(outDir, `${source}.jsonl`);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        entries.push(JSON.parse(line) as LogEntry);
      } catch {
        /* skip malformed */
      }
    }
  }
  entries.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return entries;
}

function fmtRel(ms: number): string {
  const sign = ms < 0 ? "-" : "+";
  return `${sign}${(Math.abs(ms) / 1000).toFixed(3)}s`;
}

/** Write the merged, sorted, human-readable timeline to `<outDir>/timeline.log`.
 *  Each line: `<iso> (+rel) source/level: message`, anchored at the first event. */
export function writeTimeline(outDir: string, fileName = "timeline.log"): { file: string; count: number } {
  const entries = buildSessionTimeline(outDir);
  const t0 = entries.length > 0 ? Date.parse(entries[0]!.ts) : 0;
  const lines = entries.map((e) => {
    const rel = fmtRel(Date.parse(e.ts) - t0);
    const msg = e.message.replace(/\n/g, "\n    "); // indent multi-line bodies
    return `${e.ts} (${rel}) ${e.source}/${e.level}: ${msg}`;
  });
  const file = join(outDir, fileName);
  writeFileSync(file, lines.length > 0 ? lines.join("\n") + "\n" : "", "utf8");
  return { file, count: entries.length };
}
