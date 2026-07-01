/**
 * Conversation service — the orchestrator's core job.
 *
 * Owns the Conversation (the top primitive): creates it, assembles prompts,
 * drives the runner to add Agent Sessions to it, records Events at every
 * boundary, and renders it. The runner is called as a LIBRARY (the one-way edge);
 * the orchestrator points each session's out dir inside the conversation's own
 * directory so all logs land in one place (§3.2).
 */
import { mkdirSync } from "node:fs";
import { runSession, type AfterWork } from "@automations/runner";
import type {
  AgentResult,
  AgentSession,
  AgentSessionSettings,
  Conversation,
  Credentials,
  Event,
  EventType,
  Target,
} from "@automations/core";
import { publish as ghPublish, type PublishOutcome } from "../github/liaison.ts";
import {
  appendEvent,
  getOwnedConversation,
  listConversations,
  readEvents,
  saveConversation,
  sessionDir,
} from "../state/store.ts";
import { buildTimeline } from "../logs/timeline.ts";
import { readJSONFile } from "./read.ts";

// Global concurrency cap (docs/saas-plan.md Phase 1.5). Each launched run holds a
// sandbox; unbounded launches on pooled Daytona = unbounded cost + quota
// exhaustion. 0 (default) = unlimited, so single-operator local runs are
// unaffected; hosted sets a real ceiling. Per-user caps come with accounts.
const MAX_CONCURRENT = Number(process.env.AUTOMATIONS_MAX_CONCURRENT_SESSIONS ?? 0);
  let inFlight = 0;

/** Thrown when a launch would exceed the concurrency cap; surfaces as a 4xx. */
export class AtCapacityError extends Error {
  constructor(limit: number) {
    super(`at capacity: ${limit} concurrent session(s) already running — try again shortly`);
    this.name = "AtCapacityError";
  }
}

function id(prefix: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${prefix}-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

function emit(convId: string, type: EventType, sessionId?: string, data?: Record<string, unknown>): void {
  const event: Event = {
    ts: new Date().toISOString(),
    type,
    conversationId: convId,
    ...(sessionId ? { sessionId } : {}),
    ...(data ? { data } : {}),
  };
  appendEvent(convId, event);
}

/** Prompt assembly is the orchestrator's job (architecture §3.1 Prompt). M2 keeps
 *  it minimal: persona + task + carried context → one assembled string. */
function assemble(parts: { persona?: string | undefined; task: string; carryContext?: string | undefined }): string {
  return [parts.persona, parts.carryContext, parts.task].filter(Boolean).join("\n\n");
}

export function createConversation(ownerUserId: string, input: { title: string; target: Target }): Conversation {
  const now = new Date().toISOString();
  const conv: Conversation = {
    id: id("conv"),
    ownerUserId,
    title: input.title,
    target: input.target,
    sessionIds: [],
    createdAt: now,
    updatedAt: now,
  };
  saveConversation(conv);
  emit(conv.id, "conversation_created");
  return conv;
}

export interface StartSessionInput {
  settings: Omit<AgentSessionSettings, "target">;
  /** either a pre-assembled prompt, or task (+ optional persona) to assemble */
  prompt?: string;
  persona?: string;
  task?: string;
  /** after the session finishes, the orchestrator pushes + opens/updates the PR
   *  and posts the agent's publish content (§4.4). Opt-in: outward + irreversible. */
  publish?: boolean;
  /** after a successful coding session, auto-start a QA session that screenshots
   *  the feature and publishes a single image. Opt-in. */
  qaReview?: boolean;
}

// `credentials` are resolved by the caller's Identity adapter (never from the
// request body — secrets must not be client-supplied) and threaded into the run
// + the publish token. Omitted for callers that rely on host fallbacks.
export function startSession(ownerUserId: string, convId: string, input: StartSessionInput, credentials?: Credentials): { sessionId: string } {
  const conv = getOwnedConversation(convId, ownerUserId);
  if (!conv) throw new Error(`unknown conversation ${convId}`);
  return launchSession(ownerUserId, convId, input, conv.target, credentials);
}

// Shared session launcher. `target` is the checkout this session runs against —
// usually the conversation's, but the chained QA session overrides it to clone
// the branch the coding agent just pushed. A QA session is an ordinary session:
// same agent, same settings — only the prompt (and its target) differ.
function launchSession(ownerUserId: string, convId: string, input: StartSessionInput, target: Target, credentials?: Credentials): { sessionId: string } {
  const conv = getOwnedConversation(convId, ownerUserId);
  if (!conv) throw new Error(`unknown conversation ${convId}`);

  // Capacity check BEFORE any state mutation, so a rejected launch leaves
  // nothing half-created. There are no awaits between this check and the
  // reservation below, so another launch cannot interleave in this process.
  if (MAX_CONCURRENT > 0 && inFlight >= MAX_CONCURRENT) throw new AtCapacityError(MAX_CONCURRENT);

  const sessionId = id("sess");
  const settings: AgentSessionSettings = { ...input.settings, target };
  const prompt =
    input.prompt ?? assemble({ persona: input.persona, task: input.task ?? "", carryContext: input.settings.carryContext });
  const outDir = sessionDir(convId, sessionId);
  mkdirSync(outDir, { recursive: true });

  conv.sessionIds.push(sessionId);
  conv.updatedAt = new Date().toISOString();
  saveConversation(conv);
  emit(convId, "session_started", sessionId, { settings, prompt });

  // Publish runs as the runner's afterWork hook — with the LIVE backend, before
  // dispose — so the push comes from where the commits actually are (host for
  // local/container, the sandbox for daytona). We capture the outcome and emit
  // the conversation Event after session_finished (clean ordering). The publish
  // log lines land in the session log and get folded into timeline.log by the
  // runner's own finally (which runs after this hook).
  let outcome: PublishOutcome | undefined;
  let publishError: string | undefined;
  let publishBranch: string | undefined;
  const afterWork: AfterWork | undefined = input.publish
    ? async (ctx) => {
        const result = ctx.output[ctx.settings.agent] as AgentResult | undefined;
        if (!result) {
          publishError = "no agent result to publish";
          return;
        }
        // For remote we push the branch the agent actually worked on (the new
        // branch if one was created, else the cloned branch) and open the PR
        // against the cloned base. For local the target branch is the push branch.
        const target = conv.target;
        const branch = target.kind === "remote" ? target.newBranch ?? target.branch : target.branch;
        const base = target.kind === "remote" ? target.branch : undefined;
        publishBranch = branch;
        try {
          outcome = await ghPublish(
            { backend: ctx.backend, workdir: ctx.workdir, branch, ...(base ? { base } : {}), ...(credentials?.githubToken ? { token: credentials.githubToken } : {}), result },
            ctx.log,
          );
        } catch (err) {
          ctx.log.emit("orchestrator", "error", `publish failed: ${String(err)}`);
          publishError = String(err);
        }
      }
    : undefined;

  // Reserve only after synchronous setup succeeds; otherwise a filesystem or
  // state-store exception would permanently consume a capacity slot.
  inFlight += 1;
  let slotHeld = true;
  const releaseSlot = (): void => {
    if (!slotHeld) return;
    slotHeld = false;
    inFlight -= 1;
  };

  void runSession({ sessionId, settings, prompt, outDir, ...(credentials ? { credentials } : {}), ...(afterWork ? { afterWork } : {}) })
    .then((res) => {
      emit(convId, "session_finished", sessionId, { output: res.output });
      if (input.publish) {
        // A successful push surfaces as "published" even when no PR was opened
        // (e.g. head==base) so the console can show the branch that landed.
        if (outcome?.pushed) emit(convId, "published", sessionId, { ...outcome, ...(publishBranch ? { branch: publishBranch } : {}) });
        else emit(convId, "publish_failed", sessionId, outcome ? { ...outcome, ...(publishBranch ? { branch: publishBranch } : {}) } : { error: publishError ?? "unknown" });
      }
      // The primary backend has been disposed by runSession at this point.
      // Release its capacity before attempting to reserve a slot for chained QA.
      releaseSlot();
      // Chain a QA session once the coding work is on a branch we can clone. The
      // QA session's own input carries no qaReview, so it never re-chains.
      if (input.qaReview) {
        chainQa(ownerUserId, convId, input, { pushed: outcome?.pushed === true, branch: publishBranch }, credentials);
      }
    })
    .catch((err) => {
      releaseSlot();
      emit(convId, "session_failed", sessionId, { error: String(err) });
    });

  return { sessionId };
}

function qaPrompt(task: string, branch: string): string {
  return [
    `You are a QA reviewer. A change was just implemented and pushed to branch \`${branch}\`, already checked out in this workspace.`,
    "",
    "The change that was requested:",
    task.trim() || "(no task description was provided)",
    "",
    "Your job is to verify the change visually:",
    "- Work out how to run this app/feature in this repo and exercise the change above.",
    "- Capture screenshots as you go.",
    "- Produce a SINGLE image that best shows whether the feature works (crop, combine, or annotate if that tells the story better).",
    "- Do NOT modify the application code.",
    "",
    "When finished, publish exactly ONE image via publish.json with a short caption stating whether it works.",
  ].join("\n");
}

// Auto-start a QA session that clones the just-pushed branch and screenshots the
// feature. Requires a remote target and a successful push (the coding sandbox is
// already gone, so the work has to be reachable on the remote).
function chainQa(ownerUserId: string, convId: string, codingInput: StartSessionInput, push: { pushed: boolean; branch: string | undefined }, credentials?: Credentials): void {
  const conv = getOwnedConversation(convId, ownerUserId);
  if (!conv) return;
  if (conv.target.kind !== "remote") {
    emit(convId, "qa_skipped", undefined, { reason: "QA review needs a GitHub target — it clones the pushed branch" });
    return;
  }
  if (!push.pushed || !push.branch) {
    emit(convId, "qa_skipped", undefined, { reason: "QA review needs a pushed branch — enable “Open a draft PR” and “Create a new branch”" });
    return;
  }
  const target: Target = { kind: "remote", repo: conv.target.repo, branch: push.branch };
  // Same agent and settings as the coding session — only the prompt (and the
  // branch it clones) differ. "QA" is a prompt, not an agent type. Runs inside the
  // primary run's .then, so swallow a capacity rejection as qa_skipped rather than
  // letting it surface as a failure of the (already-finished) coding session.
  try {
    launchSession(ownerUserId, convId, { settings: codingInput.settings, prompt: qaPrompt(codingInput.task ?? "", push.branch) }, target, credentials);
  } catch (err) {
    if (err instanceof AtCapacityError) emit(convId, "qa_skipped", undefined, { reason: err.message });
    else throw err;
  }
}

export interface RenderedConversation {
  conversation: Conversation;
  sessions: AgentSession[];
  events: Event[];
  timeline: ReturnType<typeof buildTimeline>;
}

export function renderConversation(ownerUserId: string, convId: string): RenderedConversation | null {
  const conversation = getOwnedConversation(convId, ownerUserId);
  if (!conversation) return null;
  const events = readEvents(convId);
  const started = new Map<string, Event>();
  for (const event of events) {
    if (event.type === "session_started" && event.sessionId) started.set(event.sessionId, event);
  }
  const terminal = new Map<string, Event>();
  for (const event of events) {
    if (
      event.sessionId &&
      (event.type === "session_finished" || event.type === "session_failed" || event.type === "published" || event.type === "publish_failed")
    ) {
      terminal.set(event.sessionId, event);
    }
  }
  const sessions = conversation.sessionIds.map((sid) => {
    const record = readJSONFile<AgentSession>(sessionDir(convId, sid), "session.json");
    if (record) return { ...record, conversationId: convId };
    const start = started.get(sid);
    const settings = start?.data?.settings as AgentSession["settings"] | undefined;
    const prompt = typeof start?.data?.prompt === "string" ? start.data.prompt : "";
    const end = terminal.get(sid);
    return {
      id: sid,
      conversationId: convId,
      settings: settings ?? {
        backend: "local",
        target: conversation.target,
        provider: "pi",
        model: "unknown",
        agent: "generic",
      },
      prompt: { persona: settings?.agent ?? "generic", task: prompt, assembled: prompt },
      status: end?.type === "session_failed" || end?.type === "publish_failed" ? "failed" : end ? "done" : "running",
      ...(start ? { startedAt: start.ts } : {}),
      ...(end ? { finishedAt: end.ts } : {}),
      ...(end?.data?.error ? { error: String(end.data.error) } : {}),
    } satisfies AgentSession;
  });
  return {
    conversation,
    sessions,
    events,
    timeline: buildTimeline(convId),
  };
}

export function list(ownerUserId: string): Conversation[] {
  return listConversations(ownerUserId);
}
