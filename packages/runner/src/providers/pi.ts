/**
 * pi provider (stub) — drives @mariozechner/pi-coding-agent inside the backend.
 *
 * M1 plan: spawn pi via backend.exec with a printed completion sentinel +
 * wall-clock timeout + heartbeat (architecture.md §2.7 — do NOT trust exit_code
 * for long sandbox processes). Capture pi's session JSONL and re-emit each block
 * as an `agent`-source log line (thinking / text / toolCall / toolResult), so the
 * transcript is a first-class log source, not a scraped file.
 */
import type { Blackboard } from "@automations/core";
import { registerProvider, type Provider, type ProviderRunInput } from "./index.ts";

class PiProvider implements Provider {
  readonly kind = "pi";

  async run({ settings, log }: ProviderRunInput): Promise<Blackboard> {
    log.emit("agent", "info", `pi provider invoked (model=${settings.model}, agent=${settings.agent})`);
    // TODO(M1): assemble pi argv, exec through the backend, stream the transcript.
    log.emit("agent", "warn", "pi provider not yet implemented — returning empty blackboard");
    return { [settings.agent]: { changed: false, note: "pi provider stub" } };
  }
}

registerProvider("pi", (settings) => new PiProvider(settings));
