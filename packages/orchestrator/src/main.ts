/**
 * @automations/orchestrator — owns the Conversation; the trust boundary.
 *
 * M2: durable state + per-conversation log directory; create a Conversation, run
 * Agent Sessions through the runner (as a library), ingest their source-separated
 * logs, and render the unified timeline over an HTTP API.
 *
 * Also owns SANDBOX-CLOSING SAFETY (docs/saas-plan.md Phase 1.5): on boot it reaps
 * orphan sandboxes a prior crashed process leaked, and on SIGTERM/SIGINT (every
 * Railway deploy) it disposes the sandboxes of in-flight runs before exiting —
 * so a deploy never strands a billable sandbox.
 */
import { disposeActiveSessions, reapOrphanSandboxes } from "@automations/runner";
import { startServer } from "./api/server.ts";

const port = Number(process.env.PORT ?? 7700);
const server = startServer(port);

// Boot-time sweep: delete idle sandboxes left over from a previous process that
// died before it could dispose them. No-op without DAYTONA_API_KEY.
void reapOrphanSandboxes((line) => process.stdout.write(line)).then((n) => {
  if (n > 0) process.stdout.write(`startup: reaped ${n} orphan sandbox(es)\n`);
});

// Graceful shutdown: stop accepting connections, then dispose every live run's
// sandbox within a bounded window (Railway SIGKILLs ~30s after SIGTERM, so we cap
// the dispose sweep well under that and exit regardless).
const SHUTDOWN_TIMEOUT_MS = 25_000;
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`\n${signal} received — closing server + disposing active sandboxes…\n`);
  server.close();
  const capped = new Promise<number>((resolve) => setTimeout(() => resolve(-1), SHUTDOWN_TIMEOUT_MS));
  const disposed = await Promise.race([disposeActiveSessions(), capped]);
  process.stdout.write(disposed < 0 ? "dispose timed out — exiting anyway\n" : `disposed ${disposed} active sandbox(es)\n`);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
