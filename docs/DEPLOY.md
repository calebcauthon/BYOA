# Deploying to Railway

Deploys as a **single service**. Railpack auto-detects `railpack.json` at the
repo root — no extra environment variables required.

## What it does

1. `npm ci` — install the workspace.
2. `npm run build -w @automations/console` — Vite-build the console UI into
   `apps/console/dist` (this dir is gitignored, so it must be built here).
3. Start `node packages/orchestrator/src/main.ts` — the Node API server, which
   also serves the built console from `apps/console/dist`.

The orchestrator binds the `PORT` Railway provides automatically. Open the
service's URL in a browser to get the console UI; the same origin answers the
`/api/...` calls (the console defaults `VITE_API_BASE` to "" = same origin), so
no cross-origin / API-URL configuration is needed.

## Splitting into two services later

If you ever want the console hosted separately from the API, the orchestrator's
CORS is already `*`. You'd build the console with `VITE_API_BASE` pointing at
the orchestrator's public URL and serve `apps/console/dist` from its own static
host. Not needed for the single-service deploy above.
