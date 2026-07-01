# Deploying to Railway

Deploys as a **single service**. Railpack auto-detects `railpack.json` at the
repo root.

## Required environment variables (auth)

The whole app is gated behind a single-operator PIN login. Set these on the
Railway service, or **the site is left open**:

| Variable | Purpose |
|---|---|
| `AUTH_PIN` | The PIN the operator types to log in. **If unset, auth is disabled and every `/api` route is public** (a warning is logged at boot). |
| `AUTH_SECRET` | Random key used to sign session cookies (e.g. `openssl rand -hex 32`). If unset, an ephemeral key is generated and sessions reset on every restart/redeploy. |
| `AUTH_SESSION_TTL_HOURS` | Optional. Session lifetime in hours (default `720` = 30 days). |

How it works: `POST /api/auth/login` checks the PIN and sets an HTTP-only,
`SameSite=Lax`, `Secure` (behind HTTPS) cookie signed with `AUTH_SECRET`. Every
other `/api/*` route verifies that cookie in one central check
(`packages/orchestrator/src/api/auth.ts`). The static console shell stays public
so the browser can render the login screen; all data lives behind `/api`.

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
