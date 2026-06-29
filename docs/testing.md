# Manual test playbook — M1 / M2 / M3

Copy-paste test suites for the milestones built so far. These are manual
smoke/verification flows, not an automated suite. Run from the repo root unless
noted.

> Status: M1 (standalone runner), M2 (orchestrator + conversation), M3 (backends
> local/container/daytona + providers pi/claude + standardized cost) are done.
> The GitHub liaison and M4 console are not built yet.

## Prereqs (one-time)

```bash
cd ~/code/automations-v2 && npm install          # links workspaces + @types/node + @daytonaio/sdk
npx tsc -b                                        # should print "No errors found"
```

What each path needs:

| Need | For | Check |
|------|-----|-------|
| `OPENROUTER_API_KEY` env | pi provider | `echo ${OPENROUTER_API_KEY:+set}` |
| `claude` CLI logged in | claude-subscription provider | `claude --version` |
| Docker running | container backend | `docker info >/dev/null && echo ok` |
| `DAYTONA_API_KEY` env | daytona backend | `echo ${DAYTONA_API_KEY:+set}` |

The runner runs `.ts` directly via Node's type-stripping — no build step.

Gotchas to remember:
- **Model id format differs by provider.** pi uses the OpenRouter form
  `anthropic/claude-haiku-4.5`; claude-subscription uses the Claude Code id
  `claude-haiku-4-5`.
- **Container bind mount:** `/tmp` is NOT shared into the Docker VM on this
  machine but `$HOME` is — so the **container** test repo must live under `$HOME`.
  (local + daytona repos can be under `/tmp`.)
- **`.serena/`** appears in repos after a **claude** run — that's the Serena MCP
  footprint (shows as `uncommitted:true`), not a bug.
- Backends auto-dispose; set `AUTOMATIONS_KEEP_CONTAINER` / `AUTOMATIONS_KEEP_SANDBOX`
  only to poke around afterward.

---

## M1 — standalone runner (JSON spec)

Goal: `agent-session run <spec>` drives one pi session on the **local** backend,
edits + commits a real repo, and writes source-separated logs.

```bash
# 1) throwaway repo + prompt + spec
rm -rf /tmp/m1-test && mkdir -p /tmp/m1-test && cd /tmp/m1-test
git init -q && git config user.email t@t.co && git config user.name t
echo "# m1 test" > README.md && git add -A && git commit -qm init

cat > /tmp/m1-prompt.md <<'EOF'
Create a file named hello.txt whose entire contents are the single word: banana
Then stage and commit it with the message "add hello.txt". Keep it minimal.
EOF

cat > /tmp/m1-spec.json <<'EOF'
{
  "backend": "local",
  "provider": "pi",
  "model": "anthropic/claude-haiku-4.5",
  "agent": "generic",
  "target": { "kind": "local", "repoPath": "/tmp/m1-test", "branch": "master" },
  "promptFile": "/tmp/m1-prompt.md",
  "out": "/tmp/m1-test/.session"
}
EOF

cd ~/code/automations-v2

# 2) dry run — resolve + print the plan, run nothing
node packages/runner/src/cli.ts run /tmp/m1-spec.json --dry-run

# 3) real run
node packages/runner/src/cli.ts run /tmp/m1-spec.json

# 4) verify the work + artifacts
cd /tmp/m1-test
cat hello.txt                       # -> banana
git log --oneline -2                # -> "add hello.txt" on top
git status --porcelain              # -> empty (clean; .session excluded)
ls .session/                        # agent/backend/orchestrator.jsonl, prompt.md, session.json, timeline.log, pi-session/
python3 -m json.tool .session/session.json   # AgentSession record (status=done, output incl. usage.costUsd)

# 5) the pi transcript as agent-source log lines, with REAL timestamps
cat .session/agent.jsonl | python3 -c "import sys,json
for l in sys.stdin:
  o=json.loads(l); k=(o.get('data') or {}).get('kind','-')
  print(o['ts'][11:23], f\"{k:11}\", o['message'][:50])"

# 6) the derived chronological view
cat .session/timeline.log | head -20
```

Spec input also accepts **inline JSON** (`run '{…}'`) or **stdin** (`… | run`),
and `"prompt"` instead of `"promptFile"`, and `"dryRun": true`.

Regenerate the sorted timeline from any out dir:
```bash
node packages/runner/src/cli.ts timeline /tmp/m1-test/.session
```

---

## M2 — orchestrator owns a Conversation

Goal: create a Conversation over the HTTP API, start a session (runs the runner
as a library), and read back the **unified timeline** anchored at t=0.

```bash
# 1) throwaway repo
rm -rf /tmp/m2-test /tmp/m2-state && mkdir -p /tmp/m2-test && cd /tmp/m2-test
git init -q && git config user.email t@t.co && git config user.name t
echo "# m2 test" > README.md && git add -A && git commit -qm init

# 2) start the orchestrator (leave running in its own terminal)
cd ~/code/automations-v2
AUTOMATIONS_STATE_DIR=/tmp/m2-state PORT=7701 node packages/orchestrator/src/main.ts
```

In a **second terminal**:
```bash
# 3) create a conversation against the local repo
CID=$(curl -s -X POST localhost:7701/api/conversations \
  -d '{"title":"add a file","target":{"kind":"local","repoPath":"/tmp/m2-test","branch":"master"}}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")
echo "conversation: $CID"

# 4) start a session in it (returns immediately; runs async)
curl -s -X POST "localhost:7701/api/conversations/$CID/sessions" -d '{
  "settings": {"backend":"local","provider":"pi","model":"anthropic/claude-haiku-4.5","agent":"generic"},
  "task": "Create hi.txt containing the word mango, then stage and commit it with message add-hi."
}'; echo

# 5) list conversations
curl -s localhost:7701/api/conversations | python3 -m json.tool

# 6) poll until the session finishes
curl -s "localhost:7701/api/conversations/$CID" | python3 -c "import sys,json
d=json.load(sys.stdin)
print('events:', [e['type'] for e in d['events']])
print('session status:', d['sessions'][0]['status'] if d['sessions'] else '(pending)')"

# 7) the UNIFIED TIMELINE anchored at t=0 (relative offsets)
curl -s "localhost:7701/api/conversations/$CID/timeline" | python3 -c "import sys,json
d=json.load(sys.stdin); print('t0 =', d['t0'])
for e in d['entries']:
  k=(e.get('data') or {}).get('kind','')
  print(f\"{e['rel']:>9}  {e['source']:12} {k:11} {e['message'][:40]}\")"

# 7b) zero each session at its own start instead
curl -s "localhost:7701/api/conversations/$CID/timeline?anchor=session" | python3 -m json.tool

# 8) verify repo + durable state layout (one dir per conversation)
cat /tmp/m2-test/hi.txt && git -C /tmp/m2-test log --oneline -2
find /tmp/m2-state -type f | sort
```

Stop the server with Ctrl-C (or `pkill -f "orchestrator/src/main.ts"`).

API surface:
```
POST /api/conversations                 { title, target }            -> Conversation
GET  /api/conversations                                              -> Conversation[]
GET  /api/conversations/:id                                          -> rendered (conversation, sessions, events, timeline)
GET  /api/conversations/:id/timeline[?anchor=session]                -> { t0, entries[] }
POST /api/conversations/:id/sessions    { settings, task|prompt }    -> { sessionId }
```

---

## M3 — backends (container, daytona) + providers (claude) + standardized cost

The runner now has 3 backends (`local`, `container`, `daytona`) and 2 providers
(`pi`, `claude-subscription`), composable via the spec.

### M3.1 — container backend (pi inside Docker)

```bash
REPO="$HOME/m3-container"          # MUST be under $HOME (Docker VM share)
rm -rf "$REPO" && mkdir -p "$REPO" && cd "$REPO"
git init -q && git config user.email t@t.co && git config user.name t
echo "# container demo" > README.md && git add -A && git commit -qm init

docker pull node:22                # pre-pull so the 1st run doesn't stall

cat > /tmp/m3-container.json <<EOF
{ "backend":"container","provider":"pi","model":"anthropic/claude-haiku-4.5","agent":"generic",
  "target":{"kind":"local","repoPath":"$REPO","branch":"master"},
  "prompt":"Create berry.txt containing the single word blueberry, then stage and commit it with message add-berry.",
  "out":"$REPO/.session" }
EOF

cd ~/code/automations-v2
node packages/runner/src/cli.ts run /tmp/m3-container.json   # 1st run installs pi in the box (~30-45s)

# commit landed on the HOST repo (proves bind mount + isolation)
cd "$REPO" && cat berry.txt && git log --oneline -2
# container lifecycle (backend provenance) + clock offset read inside the box:
grep -iE " backend/| clock " .session/timeline.log
```

### M3.2 — claude-subscription provider (local backend)

```bash
REPO=/tmp/m3-claude
rm -rf "$REPO" && mkdir -p "$REPO" && cd "$REPO"
git init -q && git config user.email t@t.co && git config user.name t
echo "# claude demo" > README.md && git add -A && git commit -qm init

cat > /tmp/m3-claude.json <<EOF
{ "backend":"local","provider":"claude-subscription","model":"claude-haiku-4-5","agent":"generic",
  "target":{"kind":"local","repoPath":"$REPO","branch":"master"},
  "prompt":"Create veg.txt containing the single word carrot, then stage and commit it with message add-carrot.",
  "out":"$REPO/.session" }
EOF

cd ~/code/automations-v2
node packages/runner/src/cli.ts run /tmp/m3-claude.json
cd "$REPO" && cat veg.txt && git log --oneline -2
# claude's transcript was streamed live as agent lines:
grep " agent/" .session/timeline.log | grep -iE "claude (starting|finished)|→|←" | cut -c1-90
```

### M3.3 — standardized result across providers (both include cost)

After running M3.1 (pi) and M3.2 (claude):
```bash
python3 - <<'PY'
import json, os
a=json.load(open(f"{os.path.expanduser('~')}/m3-container/.session/session.json"))['output']['generic']
b=json.load(open('/tmp/m3-claude/.session/session.json'))['output']['generic']
print("pi     keys:", sorted(a), "| cost:", a['usage'].get('costUsd'))
print("claude keys:", sorted(b), "| cost:", b['usage'].get('costUsd'))
print("SAME SHAPE:", sorted(a)==sorted(b) and sorted(a['usage'])==sorted(b['usage']))
PY
```
Both return `{changed, headBefore, headAfter, uncommitted, usage{costUsd,inputTokens,outputTokens,cacheTokens,totalTokens}, transcriptRef}`.

### M3.4 — Daytona backend (cheap)

Cost levers: the `node:22`+pi image **snapshot is cached** after the first build
(re-creates ~0.6s), use **haiku + a one-line task**, let the run **auto-dispose**.

**Cheapest: backend plumbing only, NO LLM spend** — create from cached image,
check exec/clock/toolchain, delete that one sandbox:
```bash
cd ~/code/automations-v2
node --input-type=module -e '
import { Daytona, Image } from "@daytonaio/sdk";
const d = new Daytona();
const image = Image.base("node:22").runCommands("npm install -g @mariozechner/pi-coding-agent");
const box = await d.create({ image }, { timeout: 600, onSnapshotCreateLogs: () => {} });
console.log("state:", box.state, "id:", box.id);
for (const c of ["date +%s%3N", "command -v node pi git bash"]) {
  const r = await box.process.executeCommand(c);   // no cwd
  console.log(`$ ${c} -> exit ${r.exitCode}: ${(r.result||"").trim()}`);
}
await d.delete(box); console.log("disposed", box.id);
'
```

**Full cheap run — real pi session in the cloud:**
```bash
REPO=/tmp/dt-cheap                  # /tmp is fine for daytona (tar runs on host)
rm -rf "$REPO" && mkdir -p "$REPO" && cd "$REPO"
git init -q && git config user.email t@t.co && git config user.name t
echo "# dt" > README.md && git add -A && git commit -qm init

cat > /tmp/dt-spec.json <<EOF
{ "backend":"daytona","provider":"pi","model":"anthropic/claude-haiku-4.5","agent":"generic",
  "target":{"kind":"local","repoPath":"$REPO","branch":"master"},
  "prompt":"Append a line 'ok' to README.md, then stage and commit with message tweak. Do nothing else.",
  "out":"$REPO/.session" }
EOF

cd ~/code/automations-v2
node packages/runner/src/cli.ts run /tmp/dt-spec.json

# verify (commit lives in the sandbox; HEAD moving proves it ran there):
python3 -c "import json;print(json.load(open('$REPO/.session/session.json'))['output'])"
grep -iE "sandbox .* ready|uploading local repo|clock sync: offset|pi finished|deleted sandbox" "$REPO/.session/timeline.log"
```
Expect `changed: True`, a non-zero `clock sync: offset …ms`, a `deleted sandbox …` line.

> NOTE: with `daytona` + a `local` target, pi's commit lives in the sandbox copy
> and is discarded on dispose (no bind mount, nothing pushed yet). It verifies the
> backend; preserving work needs the GitHub liaison (not built yet).

Env knobs: `AUTOMATIONS_SANDBOX_IMAGE` (default node:22), `AUTOMATIONS_KEEP_SANDBOX`.

### M3.5 — respectIgnore (don't upload secrets/junk to the cloud)

Verify what *would* be uploaded — **no Daytona spend**:
```bash
R=/tmp/ig-test; rm -rf "$R"; mkdir -p "$R/src" "$R/dist"; cd "$R"
git init -q && git config user.email t@t.co && git config user.name t
printf "node_modules/\n.env\ndist/\n" > .gitignore
printf "*.log\n" > .dockerignore
echo "SECRET=xyz" > .env; echo app > src/app.js; echo log > debug.log; echo d > dist/out.js
mkdir node_modules; echo dep > node_modules/dep.js; echo "# r" > README.md
git add -A && git commit -qm init >/dev/null

echo "gitignore mode uploads (no .env / dist / node_modules):"
git -C "$R" ls-files -co --exclude-standard | sort
echo "+dockerignore also drops debug.log:"
git -C "$R" ls-files -co --exclude-standard | grep -v '\.log$' | sort
```

To exercise it for real, add to a daytona spec:
```json
"respectIgnore": ["gitignore", "dockerignore"]
```
and look for `uploading local repo … (respecting gitignore, dockerignore)` in the
timeline. Default (omitted) uploads the whole tree (minus `.session`) — which
includes gitignored secrets, so prefer respectIgnore for real repos.

---

## Safe Daytona cleanup

The runner auto-disposes its own sandbox. To inspect leftovers **(read-only —
never loop-delete; most sandboxes belong to the prototype)**:
```bash
cd ~/code/automations-v2
node --input-type=module -e '
import { Daytona } from "@daytonaio/sdk";
const d = new Daytona(); let n=0;
for await (const s of d.list()) { n++; if (n<=10) console.log(s.id, s.state); }
console.log("total:", n);
'
```
Delete a specific one only: `daytona sandbox delete <id>`.

---

## The backend × provider matrix

Any cell works — set `backend` × `provider` in the spec:

| | `provider: pi` | `provider: claude-subscription` |
|---|---|---|
| `backend: local` | M1 | M3.2 |
| `backend: container` | M3.1 | works (set both) |
| `backend: daytona` | M3.4 | needs subscription creds in the sandbox (not wired) |
