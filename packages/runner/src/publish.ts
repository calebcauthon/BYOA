/**
 * The publish output contract (architecture §4.4).
 *
 * The agent AUTHORS what to publish (comments, images) as structured JSON written
 * to a known file inside the backend; the runner reads it back and puts it on the
 * AgentResult. The orchestrator (not here) is what actually posts it.
 *
 * Mechanism (provider-agnostic):
 *   - the runner appends a small protocol instruction to the prompt telling the
 *     agent the exact path + schema to write (publishProtocol);
 *   - after the agent runs, the runner reads that file FROM the backend via
 *     backend.readDir (works on local/container/daytona) and validates it.
 */
import type { Publication } from "@automations/core";
import type { Backend } from "./backends/index.ts";
import type { SessionLog } from "./logging.ts";

/** Where the agent writes its publish JSON, inside the backend's scratch dir. */
export function publishPath(scratchDir: string): string {
  return `${scratchDir}/publish.json`;
}

/** Instruction appended to the prompt describing HOW to publish (the WHETHER is
 *  the persona/prompt's call — this is neutral plumbing). */
export function publishProtocol(scratchDir: string): string {
  return [
    "\n\n---",
    "## Publishing (optional)",
    `If you have outward content to publish — a pull-request description, a PR/issue comment, screenshots — write it as JSON to exactly this path: ${publishPath(scratchDir)}`,
    "Schema:",
    '```json',
    '{ "publish": [',
    '  { "kind": "pr-description", "title": "<optional PR title>", "body": "<github-flavored markdown describing the change>" },',
    '  { "kind": "comment", "target": "pr", "body": "<github-flavored markdown>" },',
    '  { "kind": "image", "path": "<absolute path in this environment>", "caption": "<optional>" }',
    '] }',
    '```',
    "Use `pr-description` for the PR body the orchestrator will open the pull request with; use `comment` for a remark on the PR/issue. Write the file only if you have something to publish; otherwise skip it. Do not push or touch the remote — the orchestrator publishes.",
  ].join("\n");
}

function isPublication(v: unknown): v is Publication {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (o["kind"] === "pr-description") {
    return typeof o["body"] === "string" && (o["title"] === undefined || typeof o["title"] === "string");
  }
  if (o["kind"] === "comment") return (o["target"] === "pr" || o["target"] === "issue") && typeof o["body"] === "string";
  if (o["kind"] === "image") return typeof o["path"] === "string";
  return false;
}

/** Read + validate the agent's publish.json from the backend. [] if absent/invalid. */
export async function readPublish(backend: Backend, scratchDir: string, log: SessionLog): Promise<Publication[]> {
  const files = await backend.readDir(scratchDir, ".json", log);
  const file = files.find((f) => f.path.endsWith("publish.json"));
  if (!file) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(file.content);
  } catch {
    log.emit("agent", "warn", "publish.json is not valid JSON — ignoring");
    return [];
  }
  const list = (parsed as Record<string, unknown>)?.["publish"];
  if (!Array.isArray(list)) return [];
  const valid = list.filter(isPublication);
  if (valid.length !== list.length) {
    log.emit("agent", "warn", `publish.json: dropped ${list.length - valid.length} malformed item(s)`);
  }
  if (valid.length > 0) {
    const kinds = valid.map((p) => p.kind).join(", ");
    log.emit("agent", "info", `agent authored ${valid.length} item(s) to publish (${kinds})`, { count: valid.length });
  }
  return valid;
}
