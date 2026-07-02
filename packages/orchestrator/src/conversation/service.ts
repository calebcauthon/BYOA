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
  Event,
  EventType,
  Target,
} from "@automations/core";
import { publish as ghPublish, type PublishOutcome } from "../github/liaison.ts";
import {
  appendEvent,
  getConversation,
  listConversations,
  readEvents,
  saveConversation,
  sessionDir,
} from "../state/store.ts";
import { buildTimeline } from "../logs/timeline.ts";
import { readJSONFile } from "./read.ts";

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

export function createConversation(input: { title: string; target: Target }): Conversation {
  const now = new Date().toISOString();
  const conv: Conversation = {
    id: id("conv"),
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

export function startSession(convId: string, input: StartSessionInput): { sessionId: string } {
  const conv = getConversation(convId);
  if (!conv) throw new Error(`unknown conversation ${convId}`);
  return launchSession(convId, input, conv.target);
}

// Shared session launcher. `target` is the checkout this session runs against —
// usually the conversation's, but the chained QA session overrides it to clone
// the branch the coding agent just pushed. A QA session is an ordinary session:
// same agent, same settings — only the prompt (and its target) differ.
function launchSession(convId: string, input: StartSessionInput, target: Target): { sessionId: string } {
  const conv = getConversation(convId);
  if (!conv) throw new Error(`unknown conversation ${convId}`);

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
        const branch = target.newBranch ?? target.branch;
        const base = target.kind === "remote" ? target.branch : undefined;
        publishBranch = branch;
        try {
          outcome = await ghPublish(
            {
              backend: ctx.backend,
              workdir: ctx.workdir,
              branch,
              ...(base ? { base } : {}),
              ...(target.kind === "remote" ? { repo: target.repo } : {}),
              result,
            },
            ctx.log,
          );
        } catch (err) {
          ctx.log.emit("orchestrator", "error", `publish failed: ${String(err)}`);
          publishError = String(err);
        }
      }
    : undefined;

  void runSession({ sessionId, settings, prompt, outDir, ...(afterWork ? { afterWork } : {}) })
    .then((res) => {
      emit(convId, "session_finished", sessionId, { output: res.output });
      if (input.publish) {
        // A successful push surfaces as "published" even when no PR was opened
        // (e.g. head==base) so the console can show the branch that landed.
        if (outcome?.pushed) emit(convId, "published", sessionId, { ...outcome, ...(publishBranch ? { branch: publishBranch } : {}) });
        else emit(convId, "publish_failed", sessionId, outcome ? { ...outcome, ...(publishBranch ? { branch: publishBranch } : {}) } : { error: publishError ?? "unknown" });
      }
      // Chain a QA session once the coding work is on a branch we can clone. The
      // QA session's own input carries no qaReview, so it never re-chains.
      if (input.qaReview) {
        chainQa(convId, input, { pushed: outcome?.pushed === true, branch: publishBranch });
      }
    })
    .catch((err) => emit(convId, "session_failed", sessionId, { error: String(err) }));

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
function chainQa(convId: string, codingInput: StartSessionInput, push: { pushed: boolean; branch: string | undefined }): void {
  const conv = getConversation(convId);
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
  // branch it clones) differ. "QA" is a prompt, not an agent type.
  launchSession(convId, { settings: codingInput.settings, prompt: qaPrompt(codingInput.task ?? "", push.branch) }, target);
}

export interface RenderedConversation {
  conversation: Conversation;
  sessions: AgentSession[];
  events: Event[];
  timeline: ReturnType<typeof buildTimeline>;
}

export function renderConversation(convId: string): RenderedConversation | null {
  const conversation = getConversation(convId);
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

export function list(): Conversation[] {
  return listConversations();
}
