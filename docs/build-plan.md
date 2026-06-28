# Build Plan — automations v2

Companion to [`architecture.md`](./architecture.md) (the principles & primitives)
and [`logging-map.html`](./logging-map.html) (the logging model). This doc is the
*practical* layer: stack, where the module lines are drawn, and the order we build.

## Stack decision

**TypeScript, single-language monorepo** (npm workspaces, Node ≥ 22.18).

Why, from first principles — the system is IO-bound integration glue (spawn
processes, call APIs, write logs/state, serve a UI), not compute:

- **One language across runner + orchestrator + console.** The orchestrator
  *renders* the Conversation, so sharing primitive types (`Conversation`,
  `AgentSession`, `LogEntry`) server→UI with no duplication is a standing win.
- **Native to our integration partners.** `pi` and `agent-browser` are Node
  packages — a TS runner drives (or embeds) them instead of blind stdout-scraping.
- **Fast to add to.** One toolchain, one type system, one test runner.
- The prototype's only Python-native piece was the LangChain graders, and a
  grader is just "call a model → structured output" — cheap to reimplement.

**Toolchain:** npm workspaces (built into npm 10 — no extra tool). Node's native
TS type-stripping runs `.ts` directly, so the runner works with **zero install /
zero build**. `tsc -b` for typechecking + declaration output. Vite + React for
the console. Vitest for tests (later).

> Constraint learned while scaffolding: Node strip-only mode forbids TS features
> that need code generation — **no `enum`, no parameter properties** (`constructor(private x)`),
> no namespaces. Use union types + explicit field declarations. (tsconfig already
> sets `isolatedModules` + `verbatimModuleSyntax` to keep us honest.)

## Module map (where the lines are drawn)

```
automations-v2/
  packages/
    core/         @automations/core         pure types — the primitives. No IO.
    runner/       @automations/runner        STANDALONE: run ONE agent session anywhere.
    orchestrator/ @automations/orchestrator  owns+renders Conversations; GitHub liaison; state; triggers; API.
  apps/
    console/      @automations/console       React UI the orchestrator serves.
  docs/
```

Dependency edges (one-way, enforced by what imports what):

```
core  ←  runner  ←  orchestrator  →  (serves)  →  console
                         ↘ also depends on core
```

### `core` — the primitives as types
The shared vocabulary, pure (types + tiny pure helpers like `mergeVerdict`). If
it does IO, it doesn't belong here. Mirrors architecture.md §3: `Conversation` →
`AgentSession` (+ `AgentSessionSettings`) → work; plus `Target`, `Prompt`,
`Verdict`/`Finding`, `LogEntry`/`LogSource`, `Event`, `Blackboard`, `Loop`/`Step`.

### `runner` — the standalone session (the line you asked for)
**One job: execute exactly one Agent Session, anywhere, with no orchestrator.**
`runSession()` resolves a **Backend** (where it runs) + a **Provider** (the agent
program) from the session's settings, runs the prompt, and emits source-tagged
logs + the blackboard output. The CLI (`agent-session run …`) wraps it so you can
test a prompt by hand. The orchestrator imports `runSession` as a library — the
edge never points back, which is *what makes standalone testing possible.*

```
runner/src/
  cli.ts              arg-parse → runSession  (standalone entrypoint)
  session.ts          runSession(): resolve backend+provider, run, log, return
  logging.ts          SessionLog: source-tagged JSONL, one file per source
  backends/
    index.ts          Backend interface + registry (resolveBackend)
    local.ts          bare-metal (M1)         ┐ same interface,
    container.ts      docker        (M3)      │ isolation added
    sandbox.ts        daytona       (M3)      ┘
  providers/
    index.ts          Provider interface + registry (resolveProvider)
    pi.ts             pi coding agent (M1)
    claude.ts         claude subscription (M3)
    codex.ts          codex (later)
```

Already working today (stubs): `node packages/runner/src/cli.ts run --provider pi
--model … --backend local --repo-path … --branch … --agent generic --prompt
./p.md --out ./.session [--dry-run]` → writes `agent.jsonl` / `backend.jsonl` /
`orchestrator.jsonl` into the out dir.

### `orchestrator` — owns the Conversation; the trust boundary
Everything outward and durable (see architecture.md §2.1, §4.1). Calls the runner
as a library. Planned internal shape:

```
orchestrator/src/
  conversation/   own + render Conversations; build the unified log timeline
  state/          durable file-based state (.automations-state/), events, index
  logs/           per-conversation log directory; ingest runner output
  github/         the LIAISON — comments, PR open/advance, push (only place that touches the remote)
  workflow/       interpret workflow-as-data; invoke runner per step; read blackboard; when/until
  placement/      branches, worktrees, backend choice (for now — §4.3)
  triggers/       poll / webhook / schedule / manual
  api/            HTTP the console reads
  main.ts         wire-up
```

### `console` — the UI
React + Vite. Renders what the orchestrator serves: run registry, launch surface
(remote/local × provider/model/backend/branch), the Conversation as a streaming
unified timeline, screenshot lightbox. (architecture.md §1.)

## Milestones

**M1 — Standalone session, for real (the foundation).**
Make `runner` actually run a pi session on the **local** backend end-to-end:
implement `local.ts` exec with completion sentinel + heartbeat (§2.7), implement
`pi.ts` (assemble argv, drive pi, re-emit its session JSONL as `agent`-source log
lines), write the blackboard JSON + artifacts. Exit criteria: `agent-session run`
edits a real local repo and produces a readable transcript + diff. *No
orchestrator, no GitHub yet.*

**M2 — Orchestrator owns a Conversation.**
Durable state + per-conversation log directory; create a Conversation, run a
single Agent Session through the runner, ingest its logs, **render the unified
timeline**. HTTP API: list conversations, get one (rendered), start a session.
Exit criteria: a conversation with one session is inspectable via the API, with
all four log sources interleaved by timestamp.

**M3 — Backends, providers, GitHub liaison.**
Container + sandbox backends (same interface). Claude-subscription provider.
GitHub liaison: open/advance PR, post comments, push — the only module touching
the remote. Exit criteria: a session can run in a container and the orchestrator
opens a draft PR for it.

**M4 — Console.**
Vite/React app against the M2/M3 API: run registry, launch surface, streaming
Conversation timeline, lightbox. Exit criteria: launch + watch a run without
touching the terminal.

**M5 — Workflow engine + graders + triggers.**
Workflow-as-data interpreter (loop/step/when/until over the blackboard); grader
provider (model → structured `Verdict`); the merge rule gates PR draft/ready;
polling trigger. Exit criteria: a multi-step flow (coder → grader → repair)
runs from a workflow file.

**Later:** cost/usage accounting per session; webhook/schedule triggers;
hill-climbing/improvement loop (consumes the logs).

## Open questions to settle as we go
- **Runner↔orchestrator transport.** Library call in-process (current plan) vs.
  spawn the CLI as a supervised subprocess. Library is simpler for streaming;
  revisit if we want hard process isolation per session.
- **State store.** Flat files (like the prototype) vs. SQLite. Start with files;
  SQLite if querying conversations/logs gets painful.
- **Grader reimplementation.** Direct Anthropic SDK structured output vs. pulling
  in a JS agent framework. Lean toward the SDK directly (graders are simple).
