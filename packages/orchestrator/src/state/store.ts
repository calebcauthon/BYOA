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
import type { Conversation, Event, Instruction } from "@automations/core";

export const STATE_DIR = process.env.AUTOMATIONS_STATE_DIR ?? join(process.cwd(), ".automations-state");
const CONV_DIR = join(STATE_DIR, "conversations");
const LOCAL_RECENTS_FILE = join(STATE_DIR, "local-recents.json");
const BRANCH_RECENTS_FILE = join(STATE_DIR, "branch-recents.json");
const GITHUB_FILE = join(STATE_DIR, "github.json");
const INSTRUCTIONS_FILE = join(STATE_DIR, "instructions.json");

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

// ───────────────────────────── branch recents ─────────────────────────────

export interface BranchRecent {
  repoPath: string;
  branch: string;
  selectedAt: string;
}

function normalizePath(path: string): string {
  return path.replace(/\/+$/, "") || "/";
}

export function listBranchRecents(repoPath: string): BranchRecent[] {
  const normalized = normalizePath(repoPath);
  const recents = readJSON<BranchRecent[]>(BRANCH_RECENTS_FILE);
  if (!Array.isArray(recents)) return [];
  return recents
    .filter(
      (item): item is BranchRecent =>
        typeof item?.repoPath === "string" &&
        normalizePath(item.repoPath) === normalized &&
        typeof item?.branch === "string" &&
        typeof item?.selectedAt === "string",
    )
    .sort((a, b) => (a.selectedAt < b.selectedAt ? 1 : -1))
    .slice(0, 12);
}

export function rememberBranchRecent(repoPath: string, branch: string): BranchRecent[] {
  mkdirSync(STATE_DIR, { recursive: true });
  const normalized = normalizePath(repoPath);
  const existing = readJSON<BranchRecent[]>(BRANCH_RECENTS_FILE);
  const all = Array.isArray(existing) ? existing : [];
  const now = new Date().toISOString();
  const next = [
    { repoPath: normalized, branch, selectedAt: now },
    ...all.filter((item) => !(normalizePath(item.repoPath) === normalized && item.branch === branch)),
  ].slice(0, 100);
  atomicWrite(BRANCH_RECENTS_FILE, JSON.stringify(next, null, 2));
  return listBranchRecents(normalized);
}

// ───────────────────────────── github orgs + repo cache ─────────────────────────────
//
// So the operator never re-types an organization, and the repo list for an org is
// cached on the host — page loads read the cache instantly; a manual refresh (or
// a cache miss) hits `gh repo list`.

interface ReposCacheEntry {
  fetchedAt: string;
  repos: string[];
}
interface GithubState {
  orgs: string[];
  lastOrg: string | null;
  repos: Record<string, ReposCacheEntry>;
}

function readGithubState(): GithubState {
  const raw = readJSON<Partial<GithubState>>(GITHUB_FILE);
  return {
    orgs: Array.isArray(raw?.orgs) ? raw!.orgs.filter((o): o is string => typeof o === "string") : [],
    lastOrg: typeof raw?.lastOrg === "string" ? raw!.lastOrg : null,
    repos: raw?.repos && typeof raw.repos === "object" ? (raw.repos as GithubState["repos"]) : {},
  };
}

function writeGithubState(state: GithubState): void {
  mkdirSync(STATE_DIR, { recursive: true });
  atomicWrite(GITHUB_FILE, JSON.stringify(state, null, 2));
}

export function listGithubOrgs(): { orgs: string[]; lastOrg: string | null } {
  const { orgs, lastOrg } = readGithubState();
  return { orgs, lastOrg };
}

export function rememberGithubOrg(org: string): { orgs: string[]; lastOrg: string | null } {
  const normalized = org.trim();
  if (!normalized) return listGithubOrgs();
  const state = readGithubState();
  state.orgs = [normalized, ...state.orgs.filter((o) => o !== normalized)];
  state.lastOrg = normalized;
  writeGithubState(state);
  return { orgs: state.orgs, lastOrg: state.lastOrg };
}

export function setLastGithubOrg(org: string): void {
  const normalized = org.trim();
  const state = readGithubState();
  if (!normalized || !state.orgs.includes(normalized) || state.lastOrg === normalized) return;
  state.lastOrg = normalized;
  writeGithubState(state);
}

export function readReposCache(org: string): ReposCacheEntry | null {
  return readGithubState().repos[org.trim()] ?? null;
}

export function writeReposCache(org: string, repos: string[]): void {
  const normalized = org.trim();
  if (!normalized) return;
  const state = readGithubState();
  state.repos[normalized] = { fetchedAt: new Date().toISOString(), repos };
  writeGithubState(state);
}

// ───────────────────────────── instructions ─────────────────────────────
//
// A named, reusable system prompt library (see core `Instruction`). Host-owned,
// stored as one JSON array — same shape/atomicity as the recents files above so
// a crash never truncates it. The console attaches a chosen instruction to a run
// as the prompt persona.

function instructionId(): string {
  return `inst-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function listInstructions(): Instruction[] {
  const raw = readJSON<Instruction[]>(INSTRUCTIONS_FILE);
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is Instruction =>
        typeof item?.id === "string" &&
        typeof item?.name === "string" &&
        typeof item?.body === "string" &&
        typeof item?.createdAt === "string" &&
        typeof item?.updatedAt === "string",
    )
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

/** Create (no id) or update (existing id) an instruction; stamps timestamps. */
export function saveInstruction(input: { id?: string; name: string; body: string }): Instruction {
  mkdirSync(STATE_DIR, { recursive: true });
  const now = new Date().toISOString();
  const all = listInstructions();
  const existing = input.id ? all.find((i) => i.id === input.id) : undefined;
  const saved: Instruction = existing
    ? { ...existing, name: input.name, body: input.body, updatedAt: now }
    : { id: instructionId(), name: input.name, body: input.body, createdAt: now, updatedAt: now };
  const next = existing ? all.map((i) => (i.id === saved.id ? saved : i)) : [saved, ...all];
  atomicWrite(INSTRUCTIONS_FILE, JSON.stringify(next, null, 2));
  return saved;
}

export function deleteInstruction(id: string): Instruction[] {
  const next = listInstructions().filter((i) => i.id !== id);
  mkdirSync(STATE_DIR, { recursive: true });
  atomicWrite(INSTRUCTIONS_FILE, JSON.stringify(next, null, 2));
  return next;
}
