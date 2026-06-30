# Deploying to Railway

This repo deploys as **two Railway services**, both built from the repo root
(they share the npm workspace), each selected via a Railpack config file.

## Service: `orchestrator` (Node API + serves nothing else)

- **Config file** — set service variable `RAILPACK_CONFIG_FILE=railpack.orchestrator.json`
- **Start command** — `node packages/orchestrator/src/main.ts` (defined in the config)
- Binds the `PORT` Railway provides automatically.
- CORS is already `*`, so the console may live on a different origin.

## Service: `console` (static SPA)

- **Config file** — set service variable `RAILPACK_CONFIG_FILE=railpack.console.json`
- Builds with `npm run build -w @automations/console`, then serves `dist`
  via `apps/console/serve.mjs` (dependency-free static server, SPA fallback,
  binds `PORT`).
- **Required build variable** — `VITE_API_BASE=https://<orchestrator-domain>`
  This is baked in at **build time** (Vite). It must point at the orchestrator
  service's public URL. If unset, the console calls its own origin and the API
  requests 404.

## Notes

- `RAILPACK_CONFIG_FILE` is the documented Railpack mechanism for selecting a
  non-default config per service in a monorepo.
- The orchestrator can also serve the console itself (single-service deploy)
  via its built-in static handler — see `apps/console/dist` handling in
  `packages/orchestrator/src/api/server.ts`. The two-service split here keeps
  the static frontend on its own host.
