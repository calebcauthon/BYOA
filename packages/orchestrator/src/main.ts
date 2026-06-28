/**
 * @automations/orchestrator — owns the Conversation; the trust boundary.
 *
 * M2: durable state + per-conversation log directory; create a Conversation, run
 * Agent Sessions through the runner (as a library), ingest their source-separated
 * logs, and render the unified timeline over an HTTP API.
 *
 * Still to come: GitHub liaison + sandbox/container backends (M3), the console
 * UI (M4), workflow-as-data + graders + triggers (M5). See docs/build-plan.md.
 */
import { startServer } from "./api/server.ts";

const port = Number(process.env.PORT ?? 7700);
startServer(port);
