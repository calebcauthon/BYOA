/**
 * runSession — execute exactly ONE Agent Session.
 *
 * This is the heart of the standalone runner and the module line you asked for:
 * starting a pi session (locally / container / sandbox) is THIS function, with no
 * dependency on the orchestrator, conversations, or GitHub. The orchestrator
 * imports it as a library; the CLI (cli.ts) wraps it for standalone testing.
 *
 * It does one thing: resolve a backend + provider from the session's settings,
 * run the prompt, emit source-tagged logs + the blackboard output, and return.
 */
import { join, relative, isAbsolute, extname } from "node:path";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import type {
  AgentResult,
  AgentSession,
  AgentSessionSettings,
  Blackboard,
  Credentials,
  Publication,
  SessionArtifact,
  SessionStatus,
} from "@automations/core";
import { resolveBackend, type Backend } from "./backends/index.ts";
import { resolveProvider } from "./providers/index.ts";
import { SessionLog } from "./logging.ts";
import { writeTimeline } from "./timeline.ts";
import { publishProtocol } from "./publish.ts";
import { materializeImages, imagePromptSection, type ImageInput } from "./images.ts";

// Register the adapters that ship with the runner. Importing for side effects.
import "./backends/local.ts";
import "./backends/container.ts";
import "./backends/daytona.ts";
import "./providers/pi.ts";
import "./providers/claude.ts";

// Re-export so the orchestrator can append to a session's logs + refresh its
// timeline, and type its afterWork hook against the live backend.
export { SessionLog } from "./logging.ts";
export { writeTimeline } from "./timeline.ts";
export type { Backend, ExecOpts, BackendFile } from "./backends/index.ts";
// The orchestrator drives sandbox lifecycle safety from these: dispose live
// backends on shutdown, and sweep orphans left by a prior crashed process.
export { reapOrphanSandboxes } from "./backends/daytona.ts";

// ─────────────────────── active-session registry ───────────────────────
//
// Every in-flight run's live backend, so a graceful shutdown can dispose the
// sandboxes it stood up BEFORE the process exits (Railway sends SIGTERM on every
// deploy). Without this, `void runSession(...)` abandons the promise on exit and
// the sandbox leaks — billing until Daytona's own autoStop/autoDelete catches it.
const activeSessions = new Map<string, { backend: Backend; log: SessionLog }>();

/** How many runs currently hold a live backend (used for the concurrency cap). */
export function activeSessionCount(): number {
  return activeSessions.size;
}

/**
 * Dispose every active run's backend. Called from the orchestrator's SIGTERM/
 * SIGINT handler. dispose() is idempotent, so a run's own finally disposing the
 * same backend moments later is harmless. Best-effort and never throws.
 */
export async function disposeActiveSessions(): Promise<number> {
  const entries = [...activeSessions.values()];
  activeSessions.clear();
  await Promise.allSettled(entries.map(({ backend, log }) => backend.dispose(log)));
  return entries.length;
}

/**
 * Called after the agent finishes but BEFORE the backend is disposed, with the
 * live backend in hand. This is the seam the orchestrator's GitHub liaison uses
 * to push from wherever the commits actually live (host for local/container,
 * inside the sandbox for daytona). The runner itself stays GitHub-free — it just
 * offers the seam; standalone runs pass nothing.
 */
export type AfterWork = (ctx: {
  backend: Backend;
  workdir: string;
  settings: AgentSessionSettings;
  /** the blackboard the agent wrote ({ [agent]: AgentResult }) */
  output: Blackboard;
  log: SessionLog;
}) => Promise<void>;

export interface RunSessionInput {
  sessionId: string;
  settings: AgentSessionSettings;
  /** fully-assembled prompt text */
  prompt: string;
  /** images the operator attached to the prompt — data URLs (console) or file
   *  paths (CLI). Materialized into the backend so the agent can read them and
   *  copied into the session dir for the record. */
  images?: ImageInput[];
  /** directory to write this session's logs + artifacts into */
  outDir: string;
  /** per-principal secrets for this run (LLM key, GitHub token). Resolved by the
   *  caller's Identity adapter; omitted for standalone runs, which fall back to
   *  host env / `gh auth token`. Never persisted (kept out of session.json). */
  credentials?: Credentials;
  /** optional post-work, pre-dispose hook (the orchestrator's publish step) */
  afterWork?: AfterWork;
}

export interface RunSessionResult {
  sessionId: string;
  output: Blackboard;
  outDir: string;
  /** the derived, sorted, readable chronological log for this session */
  timelinePath: string;
}

// Copy every `image` the agent published from the live backend into
// <outDir>/artifacts/. Best-effort: a missing/unreadable file is logged, never
// fatal. Returns the manifest the session record carries for the console.
async function extractArtifacts(
  backend: Backend,
  output: Blackboard,
  agent: string,
  outDir: string,
  log: SessionLog,
): Promise<SessionArtifact[]> {
  const result = output[agent] as AgentResult | undefined;
  const images = (result?.publish ?? []).filter((p): p is Extract<Publication, { kind: "image" }> => p.kind === "image");
  if (images.length === 0) return [];
  const dir = join(outDir, "artifacts");
  mkdirSync(dir, { recursive: true });
  const artifacts: SessionArtifact[] = [];
  let i = 0;
  for (const image of images) {
    i += 1;
    const name = `image-${String(i).padStart(2, "0")}${extname(image.path) || ".png"}`;
    try {
      const bytes = await backend.readBytes(image.path, log);
      writeFileSync(join(dir, name), bytes);
      artifacts.push({ kind: "image", name, ...(image.caption ? { caption: image.caption } : {}) });
      log.emit("orchestrator", "info", `saved artifact ${name} (${bytes.length} bytes) from ${image.path}`);
    } catch (err) {
      log.emit("orchestrator", "warn", `could not read published image ${image.path}: ${String(err)}`);
    }
  }
  return artifacts;
}

export async function runSession(input: RunSessionInput): Promise<RunSessionResult> {
  const { sessionId, settings, prompt, outDir } = input;
  const credentials: Credentials = input.credentials ?? {};
  const log = new SessionLog(outDir, sessionId);
  let timelinePath = "";

  log.emit("orchestrator", "info", `session ${sessionId} starting`, {
    backend: settings.backend,
    provider: settings.provider,
    model: settings.model,
    agent: settings.agent,
  });

  // Persist what we were asked to run, so a session is self-documenting and
  // reproducible (§2.9). `assembledPrompt` becomes the EXACT text sent to the
  // agent once the protocol suffix is appended (after prepare); prompt.md +
  // session.json record that, not just the bare task.
  const startedAt = new Date().toISOString();
  let assembledPrompt = prompt;
  // Filenames of any attached images, saved under <outDir>/prompt-images/. Filled
  // in once the images are materialized (after prepare); recorded on the Prompt so
  // the session record reflects exactly what was attached.
  let promptImageNames: string[] = [];
  const writeRecord = (status: SessionStatus, extra: Partial<AgentSession> = {}): void => {
    const record: AgentSession = {
      id: sessionId,
      conversationId: "", // assigned by the orchestrator (M2); standalone runs have none
      settings,
      prompt: {
        persona: settings.agent,
        task: prompt,
        ...(promptImageNames.length ? { images: promptImageNames } : {}),
        assembled: assembledPrompt,
      },
      status,
      startedAt,
      ...extra,
    };
    writeFileSync(join(outDir, "session.json"), JSON.stringify(record, null, 2), "utf8");
  };
  writeRecord("running");

  const backend = resolveBackend(settings);
  const provider = resolveProvider(settings);
  // Track this run's backend so a shutdown can dispose its sandbox. Registered
  // before prepare (dispose is a no-op until a sandbox exists) and removed in the
  // finally below once we've disposed it ourselves.
  activeSessions.set(sessionId, { backend, log });

  // Everything from prepare onward is inside the try so dispose ALWAYS runs once
  // a backend has been stood up — otherwise a failure between prepare and the run
  // (e.g. the clock probe) leaks a cloud sandbox.
  let output: Blackboard = {};
  try {
    const { workdir, scratchDir } = await backend.prepare(settings, log, credentials);
    // Orchestrator provenance: this is the orchestrator declaring the lifecycle
    // boundary, not the backend reporting about itself (the backend's own lines —
    // clock probe, dispose — are emitted inside the adapter and tagged "backend").
    log.emit("orchestrator", "info", `backend ready: ${backend.kind}`, { workdir });

    // Clock sync up front: sample the backend clock between two host readings and
    // take the midpoint, so timestamps recorded inside the backend (pi's
    // transcript) can be normalized onto the host's real timeline. ~0 for local.
    const hostBefore = Date.now();
    const backendNow = await backend.now(log); // emits its own "clock probe" debug line
    const hostAfter = Date.now();
    const hostMid = Math.round((hostBefore + hostAfter) / 2);
    const clockOffsetMs = hostMid - backendNow;
    const rttMs = hostAfter - hostBefore;
    // Show the raw arithmetic so the sync is legible from the log alone.
    log.emit(
      "orchestrator",
      "debug",
      `clock sync math: host read ${new Date(hostBefore).toISOString()} → ${new Date(hostAfter).toISOString()} ` +
        `(midpoint ${new Date(hostMid).toISOString()}); backend reported ${new Date(backendNow).toISOString()}; ` +
        `rtt=${rttMs}ms; offset = host_mid − backend = ${clockOffsetMs}ms`,
      { hostBefore, hostAfter, hostMid, backendNow, rttMs, clockOffsetMs },
    );
    log.emit(
      "orchestrator",
      "info",
      `clock sync: offset ${clockOffsetMs >= 0 ? "+" : ""}${clockOffsetMs}ms — added to backend/agent timestamps to map them onto the host 'real' timeline`,
      { clockOffsetMs, rttMs },
    );

    // If our out dir lands inside the working tree, keep it out of git so the
    // agent never commits our scratch and change-detection isn't fooled by it.
    // (Prototype lesson — .git/info/exclude.) Local-fs only; sandbox handles its
    // own isolation.
    const rel = relative(workdir, outDir);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
      const excludeFile = join(workdir, ".git", "info", "exclude");
      if (existsSync(excludeFile)) {
        appendFileSync(excludeFile, `\n${rel}/\n`, "utf8");
        log.emit("orchestrator", "info", `excluded ${rel}/ from git`);
      }
    }

    // Stage any attached images into the backend (so the agent can read them)
    // and record where they landed for the prompt section + session record.
    const staged =
      input.images && input.images.length > 0
        ? await materializeImages(input.images, backend, scratchDir, outDir, log)
        : { backendPaths: [], names: [] };
    promptImageNames = staged.names;

    // Append the image section + publish protocol ONCE here (both need the
    // backend's scratchDir), persist the exact text we send, and hand it to the
    // provider — so the recorded prompt is the prompt the agent actually got (§2.9).
    assembledPrompt = `${prompt}${imagePromptSection(staged.backendPaths)}${publishProtocol(scratchDir)}`;
    writeFileSync(join(outDir, "prompt.md"), assembledPrompt, "utf8");

    output = await provider.run({ settings, backend, workdir, prompt: assembledPrompt, scratchDir, clockOffsetMs, credentials, log });
    log.emit("orchestrator", "info", `session ${sessionId} finished`);
    // Pull published images out of the (about-to-be-disposed) backend into the
    // session dir so the console can show them. Must run before dispose.
    const artifacts = await extractArtifacts(backend, output, settings.agent, outDir, log);
    writeRecord("done", { finishedAt: new Date().toISOString(), output, ...(artifacts.length ? { artifacts } : {}) });

    // Post-work, pre-dispose seam: the orchestrator publishes from the live
    // backend (e.g. push from where the commits actually are). Degrade-don't-die:
    // a hook failure is logged but never crashes the session.
    if (input.afterWork) {
      try {
        await input.afterWork({ backend, workdir, settings, output, log });
      } catch (err) {
        log.emit("orchestrator", "error", `afterWork hook failed: ${String(err)}`);
      }
    }
  } catch (err) {
    log.emit("orchestrator", "error", `session ${sessionId} failed: ${String(err)}`);
    writeRecord("failed", { finishedAt: new Date().toISOString(), error: String(err) });
    throw err;
  } finally {
    await backend.dispose(log);
    // Keep the backend visible to the shutdown sweep until normal disposal has
    // actually completed. Deleting first creates a window where SIGTERM sees no
    // active backend and exits while Daytona deletion is still in flight.
    activeSessions.delete(sessionId);
    // Derive the sorted, readable timeline once the session is fully done — even
    // on failure. Emit the meta line first so it's included in the timeline.
    log.emit("orchestrator", "info", "writing chronological timeline → timeline.log");
    const written = writeTimeline(outDir);
    timelinePath = written.file;
    log.emit("orchestrator", "debug", `timeline.log written (${written.count} entries)`);
  }

  return { sessionId, output, outDir, timelinePath };
}
