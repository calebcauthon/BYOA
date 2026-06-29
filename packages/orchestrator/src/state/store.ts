/**
 * Durable, host-owned state (architecture.md §2.1, §2.9, ADR-0003 lineage).
 *
 * The orchestrator is the single source of truth. Layout, one directory per
 * Conversation (§3.2):
 *
 *   .automations-state/
 *     conversations/
 *       <conv-id>/
 *         conversation.json     current snapshot (written ATOMICALLY)
 *         events.jsonl          append-only, immutable transitions
 *         sessions/
 *           <session-id>/       the runner's out dir: session.json, prompt.md,
 *                               agent/backend/orchestrator/workload.jsonl, pi-session/
 *
 * Every state write is atomic (tmp + rename) so a crash never leaves a truncated
 * snapshot. Events are append-only and never rewritten.
 */
import { mkdirSync, writeFileSync, readFileSync, renameSync, readdirSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { Conversation, Event } from "@automations/core";

export const STATE_DIR = process.env.AUTOMATIONS_STATE_DIR ?? join(process.cwd(), ".automations-state");
const CONV_DIR = join(STATE_DIR, "conversations");
const LOCAL_RECENTS_FILE = join(STATE_DIR, "local-recents.json");

export function conversationDir(id: string): string {
  return join(CONV_DIR, id);
}
export function sessionsDir(convId: string): string {
  return join(conversationDir(convId), "sessions");
}
export function sessionDir(convId: string, sessionId: string): string {
  return join(sessionsDir(convId), sessionId);
}

function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, "utf8");
  renameSync(tmp, path); // atomic on the same filesystem
}

function readJSON<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

// ───────────────────────────── conversations ─────────────────────────────

export function saveConversation(conv: Conversation): void {
  mkdirSync(conversationDir(conv.id), { recursive: true });
  atomicWrite(join(conversationDir(conv.id), "conversation.json"), JSON.stringify(conv, null, 2));
}

export function getConversation(id: string): Conversation | null {
  return readJSON<Conversation>(join(conversationDir(id), "conversation.json"));
}

export function listConversations(): Conversation[] {
  if (!existsSync(CONV_DIR)) return [];
  const out: Conversation[] = [];
  for (const id of readdirSync(CONV_DIR)) {
    const conv = getConversation(id);
    if (conv) out.push(conv);
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return out;
}

// ───────────────────────────── events ─────────────────────────────

export function appendEvent(convId: string, event: Event): void {
  mkdirSync(conversationDir(convId), { recursive: true });
  appendFileSync(join(conversationDir(convId), "events.jsonl"), JSON.stringify(event) + "\n", "utf8");
}

export function readEvents(convId: string): Event[] {
  const path = join(conversationDir(convId), "events.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l) as Event;
      } catch {
        return null;
      }
    })
    .filter((e): e is Event => e !== null);
}

// ───────────────────────────── local checkout recents ─────────────────────────────

export interface LocalRecent {
  path: string;
  selectedAt: string;
}

export function listLocalRecents(): LocalRecent[] {
  const recents = readJSON<LocalRecent[]>(LOCAL_RECENTS_FILE);
  if (!Array.isArray(recents)) return [];
  return recents
    .filter((item): item is LocalRecent => typeof item?.path === "string" && typeof item?.selectedAt === "string")
    .sort((a, b) => (a.selectedAt < b.selectedAt ? 1 : -1))
    .slice(0, 12);
}

export function rememberLocalRecent(path: string): LocalRecent[] {
  mkdirSync(STATE_DIR, { recursive: true });
  const now = new Date().toISOString();
  const normalized = path.replace(/\/+$/, "") || "/";
  const next = [{ path: normalized, selectedAt: now }, ...listLocalRecents().filter((item) => item.path !== normalized)].slice(0, 12);
  atomicWrite(LOCAL_RECENTS_FILE, JSON.stringify(next, null, 2));
  return next;
}
