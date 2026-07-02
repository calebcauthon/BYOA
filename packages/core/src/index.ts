/**
 * @automations/core — the primitives, as types.
 *
 * This package is pure: types + small pure helpers, no IO. It is the shared
 * vocabulary every other package speaks. The hierarchy mirrors docs/architecture.md:
 *
 *   Conversation  (owned + rendered by the orchestrator)
 *     └─ AgentSession   (its own discrete thing; carries its own settings)
 *          └─ work, inside a Backend, via a Provider
 *
 * Nothing here knows about GitHub, the filesystem, or the network. Those live in
 * the orchestrator (liaison + state) and the runner (execution).
 */

// ───────────────────────────── identifiers ─────────────────────────────

export type ConversationId = string;
export type AgentSessionId = string;

// ───────────────────────────── Target ─────────────────────────────
// The thing a Conversation works against. Remote and local are two shapes of
// one primitive.

export type Target =
  // `branch` is the base to clone; `newBranch`, when set, is created from it after
  // clone so the agent works on a fresh branch (mirrors the local "new branch").
  | { kind: "remote"; repo: string; issue?: number; branch: string; newBranch?: string }
  | { kind: "local"; repoPath: string; branch: string; newBranch?: string };

// ───────────────────────────── Agent Session settings ─────────────────────────────
// Everything an Agent Session owns. See architecture.md §3.1.

/** Where the session physically runs. A clean adapter boundary (runner/backends). */
export type BackendKind = "local" | "container" | "daytona";

/** The agent *program* / provider that drives the session — distinct from the
 *  model. pi is a coding agent; a subscription drives Claude/ChatGPT directly. */
export type ProviderKind = "pi" | "claude-subscription" | "codex";

export interface AgentSessionSettings {
  /** where it occurs */
  backend: BackendKind;
  /** what it operates on (branch / worktree / checkout is resolved by the orchestrator) */
  target: Target;
  /** the agent program / provider — its own setting, separate from the model */
  provider: ProviderKind;
  /** the model + params — just another setting alongside the provider */
  model: string;
  modelParams?: Record<string, unknown>;
  /** the agent persona/name running this session (coder, reviewer, generic, …) */
  agent: string;
  /** carried-forward context from prior sessions in the same conversation */
  carryContext?: string;
  /**
   * Ignore files to respect when COPYING the workspace into a backend (only
   * applies to copy-based backends like daytona; bind-mounted/local see the dir
   * as-is). Opt-in; default uploads the whole tree (minus scratch). e.g.
   * ["gitignore","dockerignore"] avoids shipping ignored junk and secrets.
   */
  respectIgnore?: IgnoreKind[];
}

export type IgnoreKind = "gitignore" | "dockerignore";

/**
 * The secrets a single Agent Session needs to reach the outside world, resolved
 * PER PRINCIPAL and passed explicitly into the run — never read from ambient host
 * globals by the code that uses them (that was the single-operator shortcut).
 *
 *   • Local mode:  host env (OPENROUTER_API_KEY) + `gh auth token`.
 *   • Hosted mode: the user's BYOK key + a GitHub App installation token.
 *
 * Deliberately NOT part of AgentSessionSettings: settings are serialized to
 * session.json, and secrets must never land on disk. Credentials travel alongside
 * settings at call time and are dropped after the run.
 */
export interface Credentials {
  /** clones private repos + authorizes the push (GitHub App token hosted; `gh auth token` local) */
  githubToken?: string;
  /** the LLM gateway key injected into the agent program's env (BYOK hosted; OPENROUTER_API_KEY local) */
  llmKey?: string;
}

// ───────────────────────────── Prompt ─────────────────────────────
// The assembled instruction actually sent to an agent — a stored, inspectable
// artifact of every session, not an ephemeral string.

export interface Prompt {
  persona: string;
  task: string;
  carryContext?: string;
  operatorNotes?: string;
  images?: string[];
  /** the fully-assembled text as sent, for reproducibility */
  assembled: string;
}

// ───────────────────────────── Instruction ─────────────────────────────
// A named, reusable system prompt. Saved server-side and attached to a run as
// the Prompt's `persona`, so operators can build a library of behaviors ("terse
// refactorer", "thorough QA") independent of which robot/preset runs them.

export interface Instruction {
  id: string;
  name: string;
  /** the system-prompt text sent as the Prompt persona */
  body: string;
  createdAt: string;
  updatedAt: string;
}

// ───────────────────────────── Agent Session ─────────────────────────────

export type SessionStatus =
  | "pending"
  | "starting"
  | "running"
  | "done"
  | "no-change"
  | "failed"
  | "stopped";

export interface AgentSession {
  id: AgentSessionId;
  conversationId: ConversationId;
  settings: AgentSessionSettings;
  prompt?: Prompt;
  status: SessionStatus;
  startedAt?: string;
  finishedAt?: string;
  /** structured output the agent wrote to the blackboard */
  output?: Blackboard;
  /** files the runner pulled out of the (now-disposed) backend — e.g. a QA
   *  screenshot the agent published. Served by the orchestrator from the session
   *  dir; `name` is the filename under <session>/artifacts/. */
  artifacts?: SessionArtifact[];
  error?: string;
}

export interface SessionArtifact {
  kind: "image";
  /** filename under <session-dir>/artifacts/ */
  name: string;
  caption?: string;
}

// ───────────────────────────── Conversation ─────────────────────────────
// THE top primitive. Owned + rendered by the orchestrator.

export interface Conversation {
  id: ConversationId;
  /** Identity-port principal that owns this conversation. Legacy local records
   * omit it and are treated as owned by the built-in `local` principal only. */
  ownerUserId?: string;
  title: string;
  target: Target;
  /** ordered; the conversation reads continuous but each session is its own thing */
  sessionIds: AgentSessionId[];
  createdAt: string;
  updatedAt: string;
}

// ───────────────────────────── Blackboard ─────────────────────────────
// The only channel workflow conditions may read. Each agent writes a small
// JSON object keyed by agent name.

export type Blackboard = Record<string, unknown>;

// ───────────────────────────── Usage + AgentResult ─────────────────────────────
// The STANDARD shape every coding provider (pi, claude-subscription, …) writes to
// the blackboard, so the orchestrator/workflow can read cost + outcome uniformly
// regardless of which agent program ran.

/** Model usage + cost, normalized across providers. */
export interface Usage {
  /** total cost in USD (pi: summed per-message cost.total; claude: total_cost_usd) */
  costUsd?: number;
  inputTokens?: number;
  outputTokens?: number;
  /** cache read + write tokens, when the provider reports them */
  cacheTokens?: number;
  totalTokens?: number;
}

/**
 * Outward content the AGENT authored for the orchestrator to publish (§4.4).
 * The agent emits these in its structured output; the orchestrator (sole GitHub
 * liaison) posts them deterministically after pushing the code. Generalizes
 * beyond coding — a QA run can publish a comment + images and no code at all.
 */
export type Publication =
  /** the PR description (body) the orchestrator uses when it auto-creates/updates
   *  the pull request; optional title overrides the default */
  | { kind: "pr-description"; title?: string; body: string }
  /** a comment posted on the PR or the originating issue */
  | { kind: "comment"; target: "pr" | "issue"; body: string }
  | { kind: "image"; path: string; caption?: string };

/** What an agent reports after a session. Stored under the agent's name on
 *  the blackboard: `{ [agentName]: AgentResult }`. */
export interface AgentResult {
  /** did the agent change the repo (HEAD moved or dirty tree) */
  changed: boolean;
  headBefore: string;
  headAfter: string;
  /** uncommitted changes remained in the tree */
  uncommitted: boolean;
  /** standardized cost/usage — present for every provider */
  usage: Usage;
  /** pointer to the raw transcript (pi: session JSONL path; claude: session id) */
  transcriptRef?: string;
  /** content the agent authored for the orchestrator to publish (§4.4) */
  publish?: Publication[];
}

// ───────────────────────────── Verdict + Finding ─────────────────────────────

export type Severity = "critical" | "major" | "minor" | "info";
export type VerdictValue = "pass" | "needs_changes";

export interface Finding {
  severity: Severity;
  summary: string;
  detail?: string;
  location?: string;
}

export interface Verdict {
  verdict: VerdictValue;
  summary: string;
  findings: Finding[];
}

/** The single merge rule: any critical/major finding ⇒ needs_changes. */
export function mergeVerdict(findings: Finding[]): VerdictValue {
  return findings.some((f) => f.severity === "critical" || f.severity === "major")
    ? "needs_changes"
    : "pass";
}

// ───────────────────────────── Log entry ─────────────────────────────
// The observability primitive. One Conversation-owned directory; every source
// dumps here; separated on disk, unified for render. See architecture.md §3.2.

/** Who emitted the line. The four sources from the logging map, plus workflow. */
export type LogSource =
  | "orchestrator"
  | "backend" // the session-hosting environment (sandbox/container/bare metal)
  | "agent" // the agent program (pi/subscription) — the conversation transcript
  | "workload" // programs the agent runs (build/serve, browser, tests)
  | "workflow";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogEntry {
  /** ISO-8601, always present so a unified timeline can interleave by time */
  ts: string;
  source: LogSource;
  level: LogLevel;
  /** which session produced it (for per-conversation aggregation) */
  sessionId?: AgentSessionId;
  message: string;
  /** structured extras: tool name, exit code, transcript block kind, etc. */
  data?: Record<string, unknown>;
}

// ───────────────────────────── Event ─────────────────────────────
// Append-only, immutable state transitions. The spine of durable state.

export type EventType =
  | "conversation_created"
  | "session_started"
  | "backend_ready"
  | "agent_finished"
  | "session_finished"
  | "session_failed"
  | "published"
  | "publish_failed"
  | "qa_skipped";

export interface Event {
  ts: string;
  type: EventType;
  conversationId: ConversationId;
  sessionId?: AgentSessionId;
  data?: Record<string, unknown>;
}

// ───────────────────────────── Workflow (data, not a primitive) ─────────────────────────────
// One recursive construct: a loop. A plain sequence is a loop with maxIterations 1.

export interface Loop {
  maxIterations?: number; // default 1
  until?: string; // restricted condition over the blackboard
  body: Step[];
}

export interface Step {
  agent?: string; // exactly one of agent | loop
  loop?: string | Loop;
  when?: string; // guard
  with?: Record<string, unknown>; // templated vars merged for this invocation
}
