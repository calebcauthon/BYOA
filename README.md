# automations v2

Autonomous coding platform — the rebuild. The prototype
([`waymark/automations`](../)) was the "one to throw away"; this is built around
the primitives it surfaced.

- **What & why:** [`docs/architecture.md`](docs/architecture.md) — principles & primitives.
- **Logging model:** [`docs/logging-map.html`](docs/logging-map.html) — open in a browser.
- **How we build it:** [`docs/build-plan.md`](docs/build-plan.md) — stack, modules, milestones.

## The core idea

```
Conversation        owned + RENDERED by the orchestrator (the top primitive)
  └─ Agent Session  its own discrete thing; carries its own settings
       └─ work, inside a Backend, via a Provider (the agent program)
```

The orchestrator owns the Conversation, the durable log directory, and everything
outward (it's the sole **GitHub liaison**: comments, PRs, push). An **Agent
Session** is runnable *on its own* — that's a hard module line.

## Stack

TypeScript monorepo, npm workspaces, Node ≥ 22.18. Node runs `.ts` directly via
type-stripping, so the runner needs no build step.

```
packages/core          primitives as types (pure, no IO)
packages/runner        STANDALONE: run one agent session anywhere
packages/orchestrator  owns+renders Conversations; GitHub liaison; state; API
apps/console           React UI (Vite)
```

## Run the standalone session

The runner takes one JSON spec (file path, inline string, or stdin):

```bash
cat > /tmp/spec.json <<'EOF'
{
  "backend": "local",
  "provider": "pi",
  "model": "anthropic/claude-opus-4.8",
  "agent": "generic",
  "target": { "kind": "local", "repoPath": "/path/to/repo", "branch": "feat-x" },
  "promptFile": "/tmp/p.md",
  "out": "./.session"
}
EOF

node packages/runner/src/cli.ts run /tmp/spec.json --dry-run   # resolve + print plan
node packages/runner/src/cli.ts run /tmp/spec.json             # execute
```

Also accepts inline JSON (`run '{…}'`) or stdin (`… | run`). Use `prompt` for an
inline prompt instead of `promptFile`, and `"dryRun": true` in the spec. Attach
`"images": ["./shot.png", "data:image/png;base64,…"]` (file paths or data URLs) to
stage screenshots into the backend as files the agent can read. Logs land in the
`out` dir as one source-tagged JSONL per source (`agent`, `backend`,
`orchestrator`, `workload`).

## Develop

```bash
npm install      # links the workspace packages
make dev         # orchestrator on :7700, Vite console on :5173
npm run typecheck
```

`make dev` accepts overrides:

```bash
PORT=7701 CONSOLE_PORT=5174 AUTOMATIONS_STATE_DIR=/tmp/automations-state make dev
```
