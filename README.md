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

## Run the standalone session (works today, stubbed)

```bash
echo "Add a hello route." > /tmp/p.md
node packages/runner/src/cli.ts run \
  --provider pi --model anthropic/claude-opus-4.8 \
  --backend local --repo-path /path/to/repo --branch feat-x \
  --agent generic --prompt /tmp/p.md --out ./.session --dry-run
```

Drop `--dry-run` to execute (providers/backends are stubs until M1). Logs land in
`./.session/` as one source-tagged JSONL per source (`agent`, `backend`,
`orchestrator`, `workload`).

## Develop

```bash
npm install      # links the workspace packages
npm run typecheck
```
