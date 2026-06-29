# The One to Throw Away — Distillation for v2

> "Always build one to throw away." This is that one. It works, we like it, and
> now we extract *why* so the next version is built around the right ideas
> instead of accreting them.
>
> This document is not a description of the current code. It is a list of
> **acceptance criteria / requirements** for v2, derived from what the prototype
> proved out. Three sections:
>
> 1. **UI / UX principles** — what the interface must do and feel like.
> 2. **Technical principles** — non-negotiable properties of the system.
> 3. **Primitives** — the core concepts v2 must be *built around*, plus the
>    concepts that are real today but have **no primitive yet** (the gaps that
>    hurt).
>
> Throughout: a requirement is phrased so we can check it off. "The system
> MUST…", "The UI MUST…". Where the prototype got something *wrong* (a concept
> we lean on with no primitive backing it), it's flagged **GAP**.

---

## 1. UI / UX Principles

The audience is technical operators launching and inspecting autonomous coding
runs. They scan dense operational state quickly and need it legible under
pressure. The console is a control surface, not a marketing page.

### 1.1 Task-switching across many runs is the primary job
- The UI MUST present a single **registry of all runs in flight** (the sidebar)
  that the operator can switch between without losing place.
- Run status MUST be honest: a crashed backend or dead controller MUST surface
  as a distinct state (`orphaned`, `stale`, `backend_lost`), never as a stale
  "running". Derived health, not last-written optimism.
- Selecting a run MUST NOT reset scroll or composer state in panes the operator
  was reading.

### 1.2 The current task and its primary controls come first
- Progressive disclosure: launch controls and the active conversation are
  front; settings, raw config, and artifacts are secondary panes/tabs.
- One **launch surface** that unifies *where the work runs* (remote issue vs.
  local checkout) and *how it runs* (model, base branch, flow) in one row of
  controls, not scattered dialogs.
- Inputs that have a knowable set of values MUST autocomplete from the real
  source (GitHub repos/branches, OpenRouter model list, local folders/branches)
  rather than free-text-and-hope.

### 1.3 Transparency is a feature, not an afterthought
- The operator MUST be able to answer "what is this agent doing *right now*"
  and "what did it actually do" from the UI alone — without SSHing into a
  sandbox or grepping logs.
- The agent's real reasoning MUST stream into the conversation view: thinking,
  spoken text, tool calls, and tool results **in the order they happened** — not
  a post-hoc LLM summary standing in for the trace.
- Long-running sessions MUST show live, refreshing progress; feedback MUST be
  immediate and interruptible (a run can be stopped from the UI).
- Every durable artifact the run produced (diff, screenshots, the exact
  assembled prompt, the PR comment) MUST be reachable from the run's detail —
  the UI is the front door to troubleshooting.
- Screenshots MUST be viewable inline and in a lightbox with prev/next, since
  visual QA is a first-class output.

### 1.4 A conversation is the spine of the detail view
- Work against one target MUST read as **one continuous conversation** even
  though it is many discrete Agent Sessions under the hood (see §3 Primitives).
- The operator MUST be able to **continue** a conversation with a new prompt
  (carrying base branch / overrides forward) and **fork** it to explore an
  alternative — both as first-class buttons, not config edits.
- The composer MUST accept pasted images and pass them through to the agent.

### 1.5 Density without cramping; polish through detail
- Preserve information density using spacing, weight, and contrast to create
  scan paths — not cards-everywhere or whitespace padding.
- Tabular, stable operational data: tabular numerals, crisp text, sensible
  wrapping, visible focus, concentric radii so nested controls feel related.
- Aesthetic: dark, sleek, utilitarian; quiet, engineered. Avoid neon "hacker"
  clichés, ornamental gradients, glass, and marketing styling.

### 1.6 Config is editable in-place but never the primary surface
- The raw config (repos / prompts / workflows / monitor) SHOULD be viewable and
  editable from the console, but behind a tab — the operator launches and
  inspects far more often than they edit YAML.

---

## 2. Technical Principles

### 2.1 The orchestrator owns the Conversation and the trust boundary
- A durable **host-owned** run registry is the single source of truth. Backends
  (cloud sandbox, local container) are *observed and reconciled*, never trusted
  to write global state. Untrusted agent code MUST NOT be able to forge run
  status or move the workflow.
- The orchestrator host **owns and renders the Conversation** (§3.1), owns where
  work physically happens (branch/worktree/checkout creation, backend choice),
  and owns the durable log directory it renders from.
- **The orchestrator is the GitHub liaison.** All outward GitHub actions — PR
  comments, opening/advancing PRs, **and `git push`** — go through the
  orchestrator, not the agent session. The agent does the work inside its
  sandbox; the orchestrator decides what escapes to the remote. This keeps a
  single trust boundary for everything that touches the outside world, and
  matches what the prototype already does. See §4.

### 2.2 Code/browser execution is isolated by default — bare metal is an opt-in backend
- The default and preferred posture: the app, build, and browser run in an
  **isolated backend** (cloud sandbox or local container), and the orchestrator
  receives only diff text, screenshot bytes, and structured agent output.
- **Bare-metal/`local` is a deliberate, first-class backend** (it's the one we
  built first — see §2.3) for talking to your own machine directly: fast, free,
  no egress limits. **Security caveat:** bare-metal runs untrusted agent edits
  and commands *directly on the host* with no sandbox isolation — only point it
  at repos/branches you're willing to have an agent mutate, and never at
  untrusted issue input without a human in the loop. Isolated backends remain
  the default for anything else.
- Graders that need to read code reach into the backend through **read-only**
  tools — they can see what they judge, never modify it.

### 2.3 The execution backend is an adapter, not a fork in the code
- Cloud sandbox and local container MUST run the *exact same* dev→QA→review
  loop; only *where* commands run changes. Selecting a backend is a flag, not a
  separate code path.
- Rationale carried forward from the prototype: a local backend sidesteps cloud
  egress limits and is free, while cloud scales out — both must stay first-class
  behind one boundary.

### 2.4 Control flow is data, not code
- The orchestrator MUST NOT hardcode "photographer → coder → reviewer". The
  workflow — ordering, nesting, iteration caps, pass/fail branching — is
  declarative configuration interpreted by one small engine.
- Branching MUST stay statically analyzable: guards (`when`) and bounded early
  exits (`until`) only, no goto/labels, reference cycles rejected at load.
  Every workflow is a tree.
- Iteration MUST be bounded. No unbounded loops; a cap always exists.

### 2.5 Agents communicate through a structured, inspectable contract
- Agents MUST NOT pass state by side effect or log-scraping. Each writes a small
  JSON object to a shared **blackboard**; conditions read *only* that. (See §3.)
- Reviews MUST be structured (verdict + severity-tagged findings), and a single
  merge rule decides outcome: any critical/major finding ⇒ needs-changes ⇒ PR
  stays draft. The orchestrator stays reviewer-agnostic.

### 2.6 Degrade, don't die; never auto-merge
- A grader/agent failure (timeout, recursion limit, exception) MUST NOT crash
  the run. It degrades to the safe state (needs-changes / draft) for a human.
- Nothing auto-merges. The terminal good state is "PR marked ready"; a human
  makes the merge decision.

### 2.7 Long, chatty processes need a robust completion signal
- Do not trust an SDK's `exit_code` for long sandbox processes. Use an explicit
  printed **completion sentinel** + wall-clock timeout + heartbeat logging.
  (Learned the hard way: a blocking exec wedged the controller indefinitely.)

### 2.8 Layered, single-responsibility configuration
- Keep config layers with clear ownership and no overlap:
  - **identity + knobs** per target (base branch, model defaults, caps, labels);
  - **personas** (what each agent *is*: prompt + model + runtime);
  - **control flow** (how agents are composed/ordered);
  - **job/trigger** (what to watch, poll cadence, filters);
  - **secrets** (gitignored, env overrides win).
- Each target repo declares **how to build and serve itself** (devcontainer +
  serve/route metadata). The platform does not know any one app's build; a
  sane static fallback covers repos that declare nothing.
- Single provider gateway for models (one key, per-target overridable, graders
  deterministic at temperature 0).

### 2.9 Every run is reproducible and self-documenting
- The exact assembled prompt sent to each agent MUST be written to disk, with
  its path printed. State is written atomically at every orchestration boundary.
  Transitions are appended to an immutable event log.
- Runs started from the UI MUST remain attachable/inspectable as a real terminal
  session, not an opaque detached child.

---

## 3. Primitives

The point of throwing this one away: build v2 *around* the primitives, instead
of discovering them late and bolting them on. A primitive is a core concept that
**spans** the system and **adapts** across contexts. Below: the primitives the
prototype proved real, then the concepts we lean on that have **no primitive
yet** — the gaps v2 must close.

### 3.1 Primitives to build around

**Conversation — THE top primitive.** The user-level conversation is the root of
everything; every other primitive exists in service of one Conversation. **The
orchestrator host owns it and is solely responsible for rendering it.** To render
it the orchestrator reads many logs from many sources (§3.3), but ownership and
rendering are never delegated — backends and agents *emit into* a Conversation,
they do not own or render it. In the prototype a Conversation was *derived* by
grouping runs on a key; in v2 it is a first-class, stored, owned object that the
orchestrator renders. Continue and fork operate on it; settings carry forward
through it.

**Target (a.k.a. Source).** The thing a Conversation works *against*: a remote
`repo + issue + branch`, or a local `repo path + branch/worktree`. Everything
hangs off the Target. Today it lives implicitly in a "conversation key"; in v2 it
should be an explicit, named object so remote/local are two shapes of one
primitive.

**Agent Session.** The unit directly underneath a Conversation. A user
Conversation is **made up of multiple Agent Sessions** — logically the
Conversation reads as continuous, but each Agent Session is really its own
discrete thing (its own invocation, its own execution). Data may carry between
sessions, but they are not one continuous process. (This is what we've loosely
called an "agent run"; **Agent Session** is the settled name.)

Crucially, **an Agent Session owns its own settings** — it is where all the
per-run configuration lives:
- *where it occurs* — the backend (cloud sandbox / local container / bare metal);
- *what branch / worktree / checkout* it operates on;
- *the agent program / provider* it runs on — pi vs. a Claude/ChatGPT
  subscription vs. codex, etc. This is its own setting, separate from the model;
- *the model* and any model parameters (just another setting alongside the
  provider);
- the agent/persona, the prompt, carried-forward context, operator notes, images.

So the hierarchy is: **Conversation** (owned + rendered by the orchestrator) →
**Agent Session** (its own thing, carrying its own settings) → the agent's work
inside a Backend. Continue/fork add a new Agent Session to the Conversation;
settings can be inherited from the prior session or changed for the new one.

**Prompt.** The assembled instruction actually sent to an agent (persona +
task + carried-forward context + images + operator notes). It is a real,
persisted, inspectable object — not an ephemeral string. v2 should treat the
Prompt as a stored artifact of every Agent Session, addressable and diffable.

**Agent.** A named worker = persona (prompt) + model + **Runtime** + comment
style + lifecycle hooks. Coder, reviewer, photographer, planner are all just
Agents with different runtimes. The orchestrator never special-cases a name.

**Runtime.** The adapter that says *how/where* an Agent executes (in-sandbox
coding agent, in-sandbox browser agent, controller-side grader, planner…).
Adding a new kind of worker = adding a Runtime, not editing the orchestrator.

**Backend / Sandbox.** The execution environment an Agent Session runs in (cloud
sandbox, local container, bare metal) — selected by the session's settings. A
clean adapter boundary so the same loop runs anywhere.

**Workflow / Loop.** The composition of Agents into a bounded, branching tree.
**Note:** in the prototype this is deliberately *data, not a primitive* — and we
started with loops as a primitive and moved away from it. v2 should keep it as
declarative data interpreted by a tiny engine; resist re-promoting "the loop" to
a hardcoded concept. A plain sequence is just a loop with one iteration.

**Blackboard.** The shared, structured JSON context Agents read/write to
coordinate. The *only* channel conditions are allowed to read. Keeps agents
decoupled and the flow statically analyzable.

**Verdict + Finding.** The structured output of a judging Agent: a verdict plus
severity-tagged findings. The merge rule over findings is what gates draft vs.
ready. This is the platform's notion of "is the work good yet."

**Event.** An append-only, immutable record of a state transition on a run
(started, backend ready, agent started/finished, finished/failed). The spine of
durable state and reconciliation.

**Artifact.** A durable byte-output of an Agent Session: diff, screenshots, the
assembled prompt, the session transcript. Today these exist but are scattered
(separate branch for screenshots, files under several dirs). v2 should make
Artifact one addressable primitive attached to an Agent Session, with a type and
a viewer.

**Log entry (the observability primitive — see §3.3).** Every line of activity
caused by a Conversation, datestamped and source-tagged, dumped to one
Conversation-owned directory on the orchestrator host. This is the primitive the
prototype most lacked; §3.3 specifies it.

### 3.2 The logging model (resolves the prototype's headline gap)

The prototype had no log/trace primitive — `what happened` was reconstructed from
the session JSONL + `events.jsonl` + `trace.jsonl` + prompt files + tmux logs +
PR comments, across four or five places (sources #1 and #4 in the logging map
were even the *same* file). v2 fixes this with a single, opinionated model:

1. **One directory per Conversation, on the orchestrator host.** *Every* log
   produced because of a Conversation — orchestrator, the session-hosting
   environment (sandbox/container/bare metal), the agent program (pi), and the
   workload programs the agent runs — is dumped into that one directory.
2. **Separated by source, unified for render.** Streams stay in distinct files
   per source (so a sandbox log is never tangled into the run log the way it is
   today), but every entry is **datestamped** and carries its **source** (think
   front matter / a header field per entry). The orchestrator can therefore read
   them all and **decide what to use to render the Conversation**, and the UI can
   show a unified, interleaved timeline without losing provenance.
3. **The orchestrator is the only renderer.** Logs are inputs; rendering the
   Conversation is the orchestrator's job and no one else's. Backends and agents
   *ship* log entries home; they never render.
4. **Transcript is just the agent-program source.** The conversation transcript
   (thinking / input / output / tool calls) stops being a scraped, guessed-at
   file and becomes one tagged source among the four, captured once and rendered
   everywhere.

### 3.3 Concepts we rely on that STILL have no primitive — **remaining gaps**

With Conversation, Log, and Transcript now specified above, these are what's
left to design:

**GAP — Trigger / Event source.** What *starts* a run is polling-only today
(loop over labeled issues). No webhook, no cron, no manual-event primitive in a
unified shape. **v2 requirement:** a **Trigger** primitive (poll / webhook /
schedule / manual) that emits a "start an Agent Session against this Target" event, so the
event loop is not hardwired to GitHub polling.

**GAP — Cost / Accounting.** No primitive for tokens, dollars, or time spent per
session/Conversation/model. **v2 requirement:** a usage record attached to every
Agent Session so cost is visible and attributable in the UI.

**GAP — Improvement loop (hill-climbing).** The prototype logs traces "so it's
possible later" but has no primitive that consumes them to improve prompts or
workflows. Worth deciding in v2 whether this is in scope; if so, it needs the
Log primitive (§3.2) as its input.

---

## 4. Ownership & Boundaries — who does what

The rule of thumb: **the orchestrator owns the Conversation, everything that
touches the outside world (GitHub, the remote), where work physically happens,
and the durable record of it; the agent session owns the work itself inside its
sandbox.**

### 4.1 Orchestrator host owns
- **The Conversation** — ownership and rendering (§3.1).
- **The log directory** and deciding what to render from it (§3.2).
- **GitHub liaison** — *all* outward GitHub actions: PR comments, opening /
  advancing PRs, and `git push`. The agent never touches the remote directly;
  the orchestrator is the single trust boundary for what escapes the sandbox.
- **Placement of work** — creating branches, worktrees, and checkouts, and
  deciding *where* an Agent Session runs (which backend). *For now.* (See §4.3.)
- **Run-state trust boundary** — durable status, reconciliation; agents can't
  forge it.
- **Triggers** and the launch surface.

### 4.2 Agent session owns
- **The actual work** — investigation, edits, self-QA, committing inside the
  sandbox. The session produces the work and the artifacts; it does not publish
  them. It may *request* a GitHub action (e.g. "post this comment"), but the
  orchestrator performs it.

### 4.3 Expected migration (don't over-build the boundary now)
The orchestrator-owns-placement line in §4.1 is explicitly *"for now."* The
likely v2+ evolution: the agent session becomes a **high-level agent that knows
branches and worktrees** and decides where/how work should occur, then
**delegates the narrow coding work to a sub-agent.** Even then, the outward
GitHub/remote actions stay funneled through the orchestrator liaison — the
high-level agent decides *what* should happen to the remote; the orchestrator is
still the one that *does* it. So today's "orchestrator owns branches/worktrees"
is a pragmatic starting boundary, not a permanent law — design placement as
capabilities that *could* be handed to a high-level agent later, while keeping
the GitHub/remote liaison firmly on the orchestrator.

### 4.4 Publishing: the agent AUTHORS, the orchestrator PUBLISHES

How outward content (PR/issue comments, screenshots, status) gets produced and
posted, decided for v2:

- **The agent authors what to publish, as part of its own structured output.**
  Producing a comment is part of the agent's *instructions*, not a separate
  orchestrator step. The agent emits a `publish` list in its blackboard JSON
  (`outputs/<agent>.json`), e.g. `publish: [{ kind: "pr-description", title?, body },
  { kind: "comment", target: "pr"|"issue", body }, { kind: "image", path, caption }, …]`.
  The orchestrator pushes + **auto-creates the PR using the agent-authored
  `pr-description` body** (the LLM supplies the description); `comment` items are
  posted as remarks. It's **structured JSON written to a known file**, captured by
  the runner via `backend.readDir` (works on local/container/daytona) — not
  free-form text the orchestrator has to parse out.
- **The orchestrator is the sole publisher.** It pushes the code, opens/advances
  the PR, then posts the agent-authored comments/images. The actual REST/`git`
  calls are deterministic and host-side; the agent never touches the remote (§4.1).
- **Ordering:** push first (so the diff is on GitHub), *then* comment — a comment
  refers to code that's now there. The orchestrator can template in the PR URL at
  post time, since the agent authored the body before the PR existed.
- **This replaces v1's model.** v1 generated comments with a separate
  orchestrator-side LLM call (`summarize_change` over the diff), bolted on
  per-persona and assuming a code change. v2 moves the LLM work *into the agent*
  (it already has the full context of what it did — one fewer call, more
  accurate) and leaves the orchestrator's publish step **deterministic**.
- **Why it generalizes:** the unit isn't "summarize a diff," it's "the agent
  produced things to publish." A QA run can output screenshots + a comment and
  **no code at all**; a planner can output an issue comment and nothing else. The
  `publish` field is a standard part of `AgentResult` (§3.1), present for every
  agent, defaulting to empty.

---

## Appendix — One-line acceptance checklist

- [ ] Sidebar run registry with honest, reconciled status; task-switch without state loss.
- [ ] Unified launch surface (remote/local × model/branch/flow) with real autocomplete.
- [ ] Streaming, ordered agent transcript in the conversation view (no summary stand-in).
- [ ] Continue + Fork as first-class buttons; image paste in composer; screenshot lightbox.
- [ ] Orchestrator owns + renders the Conversation; owns run-state trust boundary; agents can't forge state.
- [ ] Orchestrator is the **GitHub liaison** for all outward actions — comments, PR open/advance, **and `git push`**; the agent never touches the remote directly.
- [ ] **Agent authors, orchestrator publishes** (§4.4): agents emit a `publish` list (comments/images) as structured JSON in their output; the orchestrator posts it deterministically (push → PR → comment). No separate comment-writing LLM call.
- [ ] Orchestrator owns branch/worktree/placement *for now*, designed to be handable to a high-level agent later.
- [ ] One Conversation-owned log directory: every source dumped there, datestamped + source-tagged, separated on disk, unified in the UI, rendered only by the orchestrator.
- [ ] Backend (cloud/local/host) is one adapter; identical loop everywhere.
- [ ] Control flow is declarative, bounded, statically analyzable data.
- [ ] Blackboard is the only inter-agent channel; structured verdict+findings gate the PR.
- [ ] Degrade-don't-die; never auto-merge; completion sentinel for long processes.
- [ ] Layered config with single responsibilities; per-repo build/serve declaration.
- [ ] Reproducible runs: persisted prompts, atomic state, immutable event log, attachable session.
- [ ] **Primitives** explicit: Conversation (top) → Agent Session (owns its settings) → work; plus Target, Prompt, Agent, Runtime, Backend, Workflow(data), Blackboard, Verdict/Finding, Event, Artifact, Log entry.
- [ ] **Gaps closed:** Conversation owned/rendered; one Log model; first-class Transcript. **Remaining:** Trigger primitive; Cost accounting; (optional) improvement loop.
