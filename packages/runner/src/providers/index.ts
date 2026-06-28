/**
 * Provider adapter — the agent PROGRAM that drives the session.
 *
 * Distinct from the model: pi is a coding agent (its own loop + tools); a
 * subscription drives Claude/ChatGPT directly; codex is another. All emit the
 * `agent` log source (the transcript: thinking / input / output / tool calls).
 */
import type { AgentSessionSettings, Blackboard } from "@automations/core";
import type { Backend } from "../backends/index.ts";
import type { SessionLog } from "../logging.ts";

export interface ProviderRunInput {
  settings: AgentSessionSettings;
  backend: Backend;
  workdir: string;
  /** the fully-assembled prompt text */
  prompt: string;
  log: SessionLog;
}

export interface Provider {
  readonly kind: string;
  /** run one agent session to completion; return the blackboard output it wrote */
  run(input: ProviderRunInput): Promise<Blackboard>;
}

export type ProviderFactory = (settings: AgentSessionSettings) => Provider;

const registry = new Map<string, ProviderFactory>();

export function registerProvider(kind: string, factory: ProviderFactory): void {
  registry.set(kind, factory);
}

export function resolveProvider(settings: AgentSessionSettings): Provider {
  const factory = registry.get(settings.provider);
  if (!factory) {
    throw new Error(
      `no provider registered for "${settings.provider}" (have: ${[...registry.keys()].join(", ") || "none"})`,
    );
  }
  return factory(settings);
}
