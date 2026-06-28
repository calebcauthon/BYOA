/**
 * @automations/orchestrator — owns the Conversation; the trust boundary.
 *
 * NOT YET IMPLEMENTED. This file marks the module's responsibilities so the
 * boundary is explicit from day one. The orchestrator is the only thing that:
 *
 *   • owns + RENDERS Conversations (groups AgentSessions; builds the unified,
 *     interleaved log timeline by reading the per-source JSONL the runner wrote);
 *   • owns the durable state + the per-conversation log directory (§3.2);
 *   • is the GitHub LIAISON — all PR comments, PR open/advance, and `git push`
 *     go through here; the agent never touches the remote (§4.1);
 *   • owns placement — creating branches/worktrees + choosing the backend (§4.1);
 *   • runs the workflow engine (workflow-as-data) and invokes the runner per step;
 *   • serves the HTTP API the console reads;
 *   • hosts triggers (poll / webhook / schedule / manual).
 *
 * It calls the runner as a LIBRARY:
 *
 *   import { runSession } from "@automations/runner";
 *
 * The runner has no dependency back on the orchestrator — that one-way edge is
 * what lets us run agent sessions standalone for testing.
 */
export function placeholder(): void {
  throw new Error("orchestrator not implemented yet — see docs/build-plan.md (M2+)");
}
