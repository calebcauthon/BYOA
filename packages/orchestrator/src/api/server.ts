/**
 * HTTP API the console reads (architecture §1, §2.9). Built-in node:http — the
 * orchestrator is IO glue, not a framework showcase.
 *
 *   POST /api/conversations                      { title, target }            → Conversation
 *   GET  /api/conversations                                                   → Conversation[]
 *   GET  /api/conversations/:id                                              → RenderedConversation
 *   GET  /api/conversations/:id/timeline                                     → LogEntry[] (unified)
 *   POST /api/conversations/:id/sessions         { settings, task|prompt }    → { sessionId }
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  createConversation,
  list,
  renderConversation,
  startSession,
  type StartSessionInput,
} from "../conversation/service.ts";
import type { Target } from "@automations/core";

function send(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(data);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const parts = url.pathname.replace(/^\/api\//, "").split("/").filter(Boolean);
  const method = req.method ?? "GET";

  // /api/conversations
  if (parts[0] === "conversations" && parts.length === 1) {
    if (method === "GET") return send(res, 200, list());
    if (method === "POST") {
      const body = await readBody(req);
      return send(res, 201, createConversation({ title: String(body["title"] ?? "untitled"), target: body["target"] as Target }));
    }
  }

  // /api/conversations/:id  and  /:id/timeline  and  /:id/sessions
  if (parts[0] === "conversations" && parts[1]) {
    const convId = parts[1];
    if (parts.length === 2 && method === "GET") {
      const rendered = renderConversation(convId);
      return rendered ? send(res, 200, rendered) : send(res, 404, { error: "not found" });
    }
    if (parts[2] === "timeline" && method === "GET") {
      const rendered = renderConversation(convId);
      return rendered ? send(res, 200, rendered.timeline) : send(res, 404, { error: "not found" });
    }
    if (parts[2] === "sessions" && method === "POST") {
      const body = (await readBody(req)) as unknown as StartSessionInput;
      try {
        return send(res, 202, startSession(convId, body));
      } catch (err) {
        return send(res, 400, { error: String(err) });
      }
    }
  }

  send(res, 404, { error: "no route", path: url.pathname });
}

export function startServer(port: number): void {
  const server = createServer((req, res) => {
    route(req, res).catch((err) => send(res, 500, { error: String(err) }));
  });
  server.listen(port, () => {
    process.stdout.write(`orchestrator API on http://localhost:${port}\n`);
  });
}
