/**
 * Backend adapter — WHERE an Agent Session runs.
 *
 * Same loop everywhere; only the location changes. A Backend gives the provider
 * a place to execute commands and a working tree. The orchestrator picks which
 * backend a session uses; the runner just resolves and drives it.
 */
import type { AgentSessionSettings } from "@automations/core";
import type { SessionLog } from "../logging.ts";

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** true if killed by the wall-clock timeout rather than exiting on its own */
  timedOut?: boolean;
}

export interface ExecOpts {
  cwd?: string;
  /** piped to the process's stdin (how we feed pi its prompt) */
  input?: string;
  /** merged over the ambient environment */
  env?: Record<string, string>;
  /** wall-clock kill switch + heartbeat cadence (§2.7) */
  timeoutMs?: number;
  heartbeatMs?: number;
}

export interface Backend {
  readonly kind: string;
  /** stand up the execution environment + working tree; return the workdir */
  prepare(settings: AgentSessionSettings, log: SessionLog): Promise<{ workdir: string }>;
  /** run a command in the environment, streaming output to the backend log */
  exec(cmd: string[], opts: ExecOpts, log: SessionLog): Promise<ExecResult>;
  /** tear down (or keep, for debugging) */
  dispose(log: SessionLog): Promise<void>;
}

export type BackendFactory = (settings: AgentSessionSettings) => Backend;

const registry = new Map<string, BackendFactory>();

export function registerBackend(kind: string, factory: BackendFactory): void {
  registry.set(kind, factory);
}

export function resolveBackend(settings: AgentSessionSettings): Backend {
  const factory = registry.get(settings.backend);
  if (!factory) {
    throw new Error(
      `no backend registered for "${settings.backend}" (have: ${[...registry.keys()].join(", ") || "none"})`,
    );
  }
  return factory(settings);
}
