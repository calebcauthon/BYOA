# M4 Console Design

M4 turns the existing static React console into the operator surface for the M2/M3
orchestrator. The prototype is the serious guide: dense run registry, one launch
surface, live transcript, inline artifacts, terminal-free inspection. The
architecture boundary does not change: the console renders what the orchestrator
serves; it never reads state files, shells out, talks to GitHub, or talks to
Daytona.

## Goal

Launch and watch a real Agent Session from the browser without touching a
terminal.

M4 is successful when an operator can:

- see the current Conversation registry for the active project/scope;
- create a Conversation from a local checkout or remote issue-shaped target;
- start one Agent Session with backend/provider/model/branch settings;
- watch the unified timeline stream while the session runs;
- inspect session settings, prompt, logs, diffs, screenshots, publish results,
  and failure states from the Conversation view;
- continue an existing Conversation with inherited settings.

M4 is not the workflow engine. No coder→grader loop, polling trigger, schedule,
merge gate, or cost dashboard belongs here unless it is already produced by the
orchestrator.

## Non-negotiable architecture rules

1. The orchestrator owns and renders the Conversation.
   The console calls HTTP endpoints and receives serialized primitives
   (`Conversation`, `AgentSession`, `Event`, `TimelineEntry`). It does not
   reconstruct state from `.automations-state`, JSONL files, or process logs.

2. The console is an operator client, not a control plane.
   All irreversible/outward actions go through orchestrator endpoints:
   launching sessions, stopping sessions, publishing, continuing, and forking.

3. The timeline is source-tagged all the way to the UI.
   The console may group or collapse entries, but it must retain source identity:
   `orchestrator`, `backend`, `agent`, `workload`, `workflow`.

4. Liveness is derived, not optimistic.
   A `running` badge must come from orchestrator state/reconciliation, not from
   “we clicked Launch recently.” If the backend/controller disappears, the UI
   needs a distinct stale/lost state once the orchestrator can report it.

5. The UI follows the prototype layout.
   Top scope, left run registry, middle act/read pane. Artifacts appear inline
   in the transcript first; a separate artifacts drawer can come later.

## Current starting point

Already present:

- `apps/console` has a high-quality static React prototype for launch mode and
  reading mode.
- `packages/orchestrator` exposes:
  - `GET /api/conversations`
  - `POST /api/conversations`
  - `GET /api/conversations/:id`
  - `GET /api/conversations/:id/timeline`
  - `POST /api/conversations/:id/sessions`
- `renderConversation()` returns `conversation`, `sessions`, `events`, and a
  unified `timeline`.
- Runner logs are separated by source and rendered by the orchestrator timeline.
- M3 added real local/container/daytona backends and pi/Claude providers.

Main gap:

- the console is not wired to the API, and the API is still missing a few UI
  affordances: static asset serving, live updates, stop, capabilities/options,
  and issue/project discovery.

## UX shape

### 1. Shell and run registry

The left sidebar is the operator’s task switcher. For M4 it lists
`Conversation[]` from `GET /api/conversations`, sorted by `updatedAt desc`.

Each row renders:

- title;
- target summary (`repo`, `repoPath`, issue number when present);
- last known status derived from latest session/event;
- age/updated time;
- PR/publish link if a `published` event exists.

Status derivation for M4:

- `queued` / `running`: latest session exists and no terminal event yet;
- `ready`: latest terminal event is `session_finished` or `published`;
- `failed`: latest terminal event is `session_failed` or `publish_failed`;
- `stopped`: once stop exists;
- `stale` / `backend_lost`: M4 may display these if the orchestrator reports
  them, but should not invent them client-side.

Selecting a row loads `GET /api/conversations/:id`. The selected ID lives in the
URL so refresh/share works:

- `/` or `/new` — launch mode;
- `/conversations/:id` — reading mode.

### 2. Launch mode

Launch mode keeps the current prototype structure: target settings, agent
settings, prompt, issues column.

M4 first implementation can support a minimal target set:

- local checkout:
  - `repoPath`;
  - base branch;
  - new branch toggle/name as UI state, even if branch placement is initially
    passed through as `target.branch`;
- remote-shaped target:
  - `repo`;
  - issue number;
  - branch.

Launch sequence:

1. `POST /api/conversations` with `{ title, target }`.
2. `POST /api/conversations/:id/sessions` with `{ settings, task|prompt,
   publish? }`.
3. Navigate to `/conversations/:id`.
4. Begin live timeline subscription/polling.

For issue insta-prompt, clicking an issue prefills:

- `target.kind = "remote"` or the configured repo target shape;
- title from issue title;
- prompt containing issue title, body, labels, and URL;
- branch name like `auto/issue-142-login-redirect`.

If issue discovery is not implemented yet, the issues column should be hidden or
shown as “connect GitHub discovery,” not backed by fake data.

### 3. Reading mode

Reading mode renders one continuous Conversation with session seams.

For every `AgentSession`:

- render a session settings card before that session’s timeline entries;
- show provider · model · backend, target, branch, skills/capabilities once they
  exist, prompt, start/finish time, duration, and result state;
- newest session expanded, older sessions collapsed to one-line summaries.

Timeline entries render by `source` and `data.kind`, not by brittle message
substring matching.

Suggested mapping:

| Source | Data shape | UI treatment |
| --- | --- | --- |
| `orchestrator` | event/status metadata | compact event rail, collapsible details |
| `backend` | setup, upload/download, heartbeat, sandbox logs | compact infrastructure rail |
| `agent` | transcript blocks: thinking/text/tool_call/tool_result | main conversation turns |
| `workload` | command/browser/test output | tool result cards with stdout/stderr |
| `workflow` | later M5 loop/grader state | compact workflow rail |

Unknown entries still render as plain log rows. The UI must degrade, not drop
data because a `data.kind` is new.

### 4. Live updates

Preferred M4 transport: server-sent events.

Endpoint:

```text
GET /api/conversations/:id/stream
```

Semantics:

- sends the current rendered conversation immediately;
- then sends new events/timeline entries as they land;
- includes periodic heartbeat comments;
- reconnect is safe: client refetches `GET /api/conversations/:id` on reconnect.

Fallback if SSE is not built in the first cut: poll
`GET /api/conversations/:id` every 1s while latest session is non-terminal, and
every 5–10s otherwise. The UI code should isolate the transport behind one hook
so polling can be replaced by SSE without rewriting views.

Live-follow behavior follows the prototype:

- if the user is at the live edge, new entries auto-scroll;
- if the user scrolls/copies/selects text, auto-follow pauses;
- show “Agent is working / Jump to latest” while paused.

### 5. Continue and fork

M4 should include Continue. Fork can be present as a disabled or non-MVP action
unless the orchestrator supports branch/session fork semantics.

Continue flow:

- bottom composer appears in reading mode;
- default settings inherit from the latest session;
- operator can override provider/model/backend/branch before sending;
- submit calls `POST /api/conversations/:id/sessions` with the new task and
  inherited/overridden settings.

This creates a new Agent Session in the same Conversation. It must not mutate
the prior session.

Fork requires an explicit orchestrator endpoint later because it changes the
Conversation/branch relationship. Do not fake it in the client.

### 6. Stop

The prototype has a Stop button; M4 needs a real endpoint before enabling it:

```text
POST /api/conversations/:id/sessions/:sessionId/stop
```

Expected behavior:

- orchestrator records a stop request event immediately;
- runner/backend gets an abort signal or best-effort cleanup;
- terminal state becomes `stopped` or `failed` with stop reason;
- UI disables Stop after request and displays cleanup progress.

Until this exists, the Stop button should be hidden or clearly disabled.

### 7. Inline artifacts

Artifact rendering stays inline in the transcript for M4.

Minimum artifact types:

- prompt: collapsible text block from `AgentSession.prompt`;
- command result: stdout/stderr/exit code from workload log entries;
- diff: patch text or summary emitted by provider/result;
- screenshot/image: path or URL emitted as a `Publication` or artifact log entry;
- PR/publish: `published` / `publish_failed` events.

API requirement: browser-safe artifact URLs. The console should not be handed raw
host file paths with an expectation it can read them. Add an orchestrator route
when artifacts are ready:

```text
GET /api/conversations/:id/artifacts/:artifactId
```

For M4, if artifacts are only paths in logs, render metadata and a “not yet
servable” placeholder rather than attempting filesystem access.

## API additions for M4

Required:

```text
GET  /                         serve console index.html in production/dev mode
GET  /assets/*                 serve built console assets
GET  /api/conversations        current list endpoint, sorted newest first
GET  /api/conversations/:id    current rendered endpoint
POST /api/conversations        current create endpoint
POST /api/conversations/:id/sessions
GET  /api/options              providers, models, backends, capabilities
GET  /api/conversations/:id/stream
POST /api/conversations/:id/sessions/:sessionId/stop
```

Nice-to-have if available in M4:

```text
GET /api/projects
GET /api/projects/:id/issues
GET /api/projects/:id/repos
GET /api/conversations/:id/artifacts/:artifactId
```

`/api/options` can start static and local:

```json
{
  "backends": ["local", "container", "sandbox"],
  "providers": [
    { "id": "pi", "models": ["anthropic/claude-haiku-4.5"] },
    { "id": "claude-subscription", "models": ["sonnet", "opus"] }
  ],
  "skills": [
    { "id": "browser", "requires": { "backendCapabilities": ["browser"] } }
  ]
}
```

## Frontend implementation plan

Keep the existing visual components; replace static data from the outside in.

1. Routing and API client
   - add a small typed fetch wrapper;
   - use `@automations/core` types where practical;
   - routes: new conversation and conversation detail.

2. Conversation registry
   - replace hard-coded `runs` with `GET /api/conversations`;
   - derive row status from sessions/events;
   - preserve selection and scroll behavior.

3. Launch form
   - controlled form state for target/settings/prompt;
   - fetch `/api/options`;
   - submit create+start sequence;
   - remove fake issue data unless an issues endpoint exists.

4. Conversation detail
   - render real `AgentSession` cards;
   - render timeline entries with source-specific components;
   - preserve unknown log fallback.

5. Live transport
   - implement polling hook first or SSE if the API lands at the same time;
   - keep auto-follow behavior from the prototype.

6. Actions
   - Continue with inherited settings;
   - Stop only when endpoint exists;
   - Fork disabled until orchestrator semantics exist.

7. Serve the console
   - orchestrator serves the built Vite app;
   - in dev, Vite proxy can point `/api` to the orchestrator port.

## Acceptance tests

Manual smoke flow:

1. Start orchestrator with an empty temp state dir.
2. Open the console in a browser.
3. Create a local throwaway git repo.
4. Launch a local/pi session from the console with a prompt that creates and
   commits a file.
5. Verify the run appears in the sidebar immediately.
6. Verify timeline entries appear while the session is running.
7. Verify the session ends as ready or failed without a refresh.
8. Verify the settings card shows the actual backend/provider/model/target.
9. Verify command output/log entries are inspectable in the transcript.
10. Continue the Conversation with a second prompt and verify a second session
    card appears without overwriting the first.

Terminal use is allowed to start the server for the test; it is not allowed for
launching or watching the run.

## Explicit deferrals

- full Project model and account/repo switching;
- real GitHub issue discovery if M4 starts with local targets;
- workflow engine and grader loop;
- trigger polling/webhooks/schedules;
- artifact CDN/storage model beyond orchestrator-served files;
- usage/cost dashboard beyond rendering fields already present on sessions;
- true fork semantics.

These are not UI compromises; they preserve the M4 boundary so the console lands
on top of the primitives already built instead of inventing a parallel system.
