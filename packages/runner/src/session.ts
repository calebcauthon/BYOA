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
import { join, relative, isAbsolute } from "node:path";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import type { AgentSession, AgentSessionSettings, Blackboard, SessionStatus } from "@automations/core";
import { resolveBackend } from "./backends/index.ts";
import { resolveProvider } from "./providers/index.ts";
import { SessionLog } from "./logging.ts";
import { writeTimeline } from "./timeline.ts";

// Register the adapters that ship with the runner. Importing for side effects.
import "./backends/local.ts";
import "./providers/pi.ts";

export interface RunSessionInput {
  sessionId: string;
  settings: AgentSessionSettings;
  /** fully-assembled prompt text */
  prompt: string;
  /** directory to write this session's logs + artifacts into */
  outDir: string;
}

export interface RunSessionResult {
  sessionId: string;
  output: Blackboard;
  outDir: string;
  /** the derived, sorted, readable chronological log for this session */
  timelinePath: string;
}

export async function runSession(input: RunSessionInput): Promise<RunSessionResult> {
  const { sessionId, settings, prompt, outDir } = input;
  const log = new SessionLog(outDir, sessionId);
  let timelinePath = "";

  log.emit("orchestrator", "info", `session ${sessionId} starting`, {
    backend: settings.backend,
    provider: settings.provider,
    model: settings.model,
    agent: settings.agent,
  });

  // Persist what we were asked to run, so a session is self-documenting and
  // reproducible (§2.9). The prompt is a stored artifact of every session (§3.1).
  const startedAt = new Date().toISOString();
  writeFileSync(join(outDir, "prompt.md"), prompt, "utf8");
  const writeRecord = (status: SessionStatus, extra: Partial<AgentSession> = {}): void => {
    const record: AgentSession = {
      id: sessionId,
      conversationId: "", // assigned by the orchestrator (M2); standalone runs have none
      settings,
      prompt: { persona: settings.agent, task: prompt, assembled: prompt },
      status,
      startedAt,
      ...extra,
    };
    writeFileSync(join(outDir, "session.json"), JSON.stringify(record, null, 2), "utf8");
  };
  writeRecord("running");

  const backend = resolveBackend(settings);
  const provider = resolveProvider(settings);

  const { workdir } = await backend.prepare(settings, log);
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

  const sessionDir = join(outDir, "pi-session");
  let output: Blackboard = {};
  try {
    output = await provider.run({ settings, backend, workdir, prompt, sessionDir, clockOffsetMs, log });
    log.emit("orchestrator", "info", `session ${sessionId} finished`);
    writeRecord("done", { finishedAt: new Date().toISOString(), output });
  } catch (err) {
    log.emit("orchestrator", "error", `session ${sessionId} failed: ${String(err)}`);
    writeRecord("failed", { finishedAt: new Date().toISOString(), error: String(err) });
    throw err;
  } finally {
    await backend.dispose(log);
    // Derive the sorted, readable timeline once the session is fully done — even
    // on failure. Emit the meta line first so it's included in the timeline.
    log.emit("orchestrator", "info", "writing chronological timeline → timeline.log");
    const written = writeTimeline(outDir);
    timelinePath = written.file;
    log.emit("orchestrator", "debug", `timeline.log written (${written.count} entries)`);
  }

  return { sessionId, output, outDir, timelinePath };
}
