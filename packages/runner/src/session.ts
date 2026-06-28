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
import { appendFileSync, existsSync } from "node:fs";
import type { AgentSessionSettings, Blackboard } from "@automations/core";
import { resolveBackend } from "./backends/index.ts";
import { resolveProvider } from "./providers/index.ts";
import { SessionLog } from "./logging.ts";

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
}

export async function runSession(input: RunSessionInput): Promise<RunSessionResult> {
  const { sessionId, settings, prompt, outDir } = input;
  const log = new SessionLog(outDir, sessionId);

  log.emit("orchestrator", "info", `session ${sessionId} starting`, {
    backend: settings.backend,
    provider: settings.provider,
    model: settings.model,
    agent: settings.agent,
  });

  const backend = resolveBackend(settings);
  const provider = resolveProvider(settings);

  const { workdir } = await backend.prepare(settings, log);
  log.emit("backend", "info", `backend ready: ${backend.kind}`, { workdir });

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
    output = await provider.run({ settings, backend, workdir, prompt, sessionDir, log });
    log.emit("orchestrator", "info", `session ${sessionId} finished`);
  } catch (err) {
    log.emit("orchestrator", "error", `session ${sessionId} failed: ${String(err)}`);
    throw err;
  } finally {
    await backend.dispose(log);
  }

  return { sessionId, output, outDir };
}
