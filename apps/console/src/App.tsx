import {
  ArrowDown,
  ArrowUpRight,
  Bot,
  Box,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Cloud,
  FileCode2,
  FolderGit2,
  GitBranch,
  Github,
  ImagePlus,
  Link2,
  MoreHorizontal,
  PanelLeftClose,
  Play,
  Plus,
  Search,
  Terminal,
  Wrench,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

type RunState = "running" | "ready" | "failed" | "queued" | "stopped";

const runs: Array<{ title: string; repo: string; state: RunState; age: string; pr?: string }> = [
  { title: "Fix login redirect loop", repo: "waymark/web", state: "running", age: "3m" },
  { title: "Add webhook replay", repo: "automations", state: "ready", age: "18m", pr: "#482" },
  { title: "Reduce image payload", repo: "waymark/api", state: "failed", age: "34m" },
  { title: "Audit billing retries", repo: "waymark/api", state: "queued", age: "1h" },
];

function RunStatus({ state }: { state: RunState }) {
  return (
    <span className={`run-status ${state}`}>
      <span className="status-dot" />
      {state}
    </span>
  );
}

function OrchestratorEvent({ children, time }: { children: React.ReactNode; time: string }) {
  return (
    <div className="orchestrator-event">
      <span className="event-time">{time}</span>
      <span className="event-mark"><Check size={11} strokeWidth={2.5} /></span>
      <span>{children}</span>
    </div>
  );
}

function CodeResult() {
  return (
    <div className="tool-result">
      <div className="result-header">
        <div><Terminal size={14} /> Result</div>
        <span>exit 0 · 1.2s</span>
      </div>
      <pre><span className="log-muted"> RUN  v2.1.8 /workspace/web</span>{"\n\n"}<span className="log-pass"> ✓</span> src/auth/redirect.test.ts (6 tests) 18ms{"\n"}<span className="log-pass"> ✓</span> src/routes/login.test.ts (4 tests) 11ms{"\n\n"} Test Files  <span className="log-pass">2 passed</span> (2){"\n"}      Tests  <span className="log-pass">10 passed</span> (10)</pre>
    </div>
  );
}

const issues = [
  { number: 142, title: "Login redirects loop after expired invite", labels: ["bug", "auth"], age: "2h" },
  { number: 139, title: "Webhook retries lose delivery headers", labels: ["bug"], age: "1d" },
  { number: 131, title: "Expose cache usage in run summary", labels: ["enhancement"], age: "3d" },
  { number: 127, title: "Screenshots overflow on narrow threads", labels: ["ui"], age: "5d" },
];

function FieldButton({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <button className="field-button">
      <span className="field-icon">{icon}</span>
      <span><small>{label}</small><strong>{value}</strong></span>
      <ChevronDown size={13} />
    </button>
  );
}

function NewRunView({ onLaunch }: { onLaunch: () => void }) {
  const [prompt, setPrompt] = useState("");
  const [newBranch, setNewBranch] = useState(true);
  const [skills, setSkills] = useState(["browser"]);
  const [selectedIssue, setSelectedIssue] = useState<number | null>(null);

  const chooseIssue = (issue: (typeof issues)[number]) => {
    setSelectedIssue(issue.number);
    setPrompt(`Resolve issue #${issue.number}: ${issue.title}\n\nReproduce the problem, implement a focused fix, and add regression coverage.`);
  };

  return (
    <section className="launch-view">
      <header className="launch-head">
        <div>
          <div className="eyebrow">NEW CONVERSATION</div>
          <h1>Start an agent run</h1>
          <p>Choose the target and execution context, then describe the outcome.</p>
        </div>
        <span className="draft-state">Draft saved locally</span>
      </header>

      <div className="launch-body">
        <div className="launch-main">
          <section className="launch-section">
            <div className="section-heading"><span>01</span><div><h2>Target</h2><p>Where the work should land.</p></div></div>
            <div className="field-grid target-fields">
              <FieldButton label="Repository" value="waymark/web" icon={<Github size={14} />} />
              <FieldButton label="Base branch" value="main" icon={<GitBranch size={14} />} />
            </div>
            <label className="branch-toggle">
              <input type="checkbox" checked={newBranch} onChange={(event) => setNewBranch(event.target.checked)} />
              <span className="toggle-track"><i /></span>
              <span><strong>Create a new branch</strong><small>auto/fix-login-redirect</small></span>
            </label>
          </section>

          <section className="launch-section">
            <div className="section-heading"><span>02</span><div><h2>Agent session</h2><p>How and where the agent runs.</p></div></div>
            <div className="field-grid runtime-fields">
              <FieldButton label="Agent" value="pi · opus 4.1" icon={<Bot size={14} />} />
              <FieldButton label="Backend" value="Daytona" icon={<Cloud size={14} />} />
            </div>
            <div className="skill-row">
              <span className="field-label">Skills</span>
              {skills.map((skill) => (
                <span className="skill-chip" key={skill}><Link2 size={11} />{skill}<button aria-label={`Remove ${skill}`} onClick={() => setSkills([])}><X size={10} /></button></span>
              ))}
              <button className="add-skill" onClick={() => setSkills(["browser"])}><Plus size={11} /> Add skill</button>
              <span className="capability-note"><Box size={11} /> Requires browser-capable backend</span>
            </div>
          </section>

          <section className="launch-section prompt-section">
            <div className="section-heading"><span>03</span><div><h2>Prompt</h2><p>Give the agent a clear outcome and useful constraints.</p></div></div>
            <div className="prompt-editor">
              <textarea
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Describe what you want the agent to change…"
                aria-label="Agent prompt"
              />
              <div className="prompt-toolbar">
                <button><ImagePlus size={14} /> Add images</button>
                <span>Paste screenshots anywhere · Markdown supported</span>
                <span className="prompt-count">{prompt.length}</span>
              </div>
            </div>
          </section>

          <div className="launch-footer">
            <div className="launch-summary">
              <span><FolderGit2 size={13} /> waymark/web</span>
              <span><Bot size={13} /> pi · opus 4.1</span>
              <span><Cloud size={13} /> Daytona</span>
            </div>
            <button className="launch-button" disabled={!prompt.trim()} onClick={onLaunch}>
              Launch run <span>⌘↵</span><ArrowUpRight size={14} />
            </button>
          </div>
        </div>

        <aside className="issues-panel">
          <div className="issues-head">
            <div><span>Open issues</span><b>{issues.length}</b></div>
            <button aria-label="Search issues"><Search size={14} /></button>
          </div>
          <p>Pick an issue to prefill a fresh conversation.</p>
          <div className="issue-list">
            {issues.map((issue) => (
              <button className={`issue-row ${selectedIssue === issue.number ? "selected" : ""}`} key={issue.number} onClick={() => chooseIssue(issue)}>
                <div className="issue-number"><span /><b>#{issue.number}</b><em>{issue.age}</em></div>
                <strong>{issue.title}</strong>
                <div className="issue-labels">{issue.labels.map((label) => <span key={label}>{label}</span>)}</div>
                <ChevronRight className="issue-arrow" size={14} />
              </button>
            ))}
          </div>
          <button className="view-github"><Github size={13} /> View all on GitHub <ArrowUpRight size={12} /></button>
        </aside>
      </div>
    </section>
  );
}

function App() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [orchestratorOpen, setOrchestratorOpen] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [composer, setComposer] = useState("");
  const [view, setView] = useState<"conversation" | "new">("conversation");

  const atLiveEdge = useCallback(() => {
    const el = viewportRef.current;
    return !!el && el.scrollHeight - el.scrollTop - el.clientHeight < 56;
  }, []);

  const pauseFollowing = useCallback(() => setFollowing(false), []);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onScroll = () => setFollowing(atLiveEdge());
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [atLiveEdge]);

  useEffect(() => {
    if (following) endRef.current?.scrollIntoView({ block: "end" });
  }, [following, stopped]);

  const jumpToLatest = () => {
    setFollowing(true);
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  };

  return (
    <main className="shell">
      <header className="topbar">
        <button className="project-switcher">
          <span className="project-avatar">A</span>
          <span><strong>Automations</strong><small>caleb · 3 repositories</small></span>
          <ChevronDown size={14} />
        </button>
        <div className="top-actions">
          <button className="icon-button" aria-label="Search"><Search size={16} /></button>
          <span className="key-hint">⌘ K</span>
          <div className="top-divider" />
          <button className="icon-button" aria-label="More options"><MoreHorizontal size={17} /></button>
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <div className="sidebar-head">
            <span>Runs <b>4</b></span>
            <button className="icon-button" aria-label="Collapse runs"><PanelLeftClose size={15} /></button>
          </div>
          <nav className="run-list" aria-label="Runs">
            {runs.map((run, index) => (
              <button className={`run-row ${index === 0 && view === "conversation" ? "selected" : ""}`} key={run.title} onClick={() => setView("conversation")}>
                <span className="run-title">{run.title}</span>
                <span className="run-meta"><RunStatus state={run.state} /><span>{run.age}</span></span>
                <span className="run-repo">{run.repo}{run.pr && <em>{run.pr}</em>}</span>
              </button>
            ))}
          </nav>
          <button className={`new-run ${view === "new" ? "active" : ""}`} onClick={() => setView("new")}><Play size={13} fill="currentColor" /> New run</button>
        </aside>

        {view === "new" ? <NewRunView onLaunch={() => setView("conversation")} /> : (
        <section className="conversation">
          <header className="conversation-head">
            <div className="title-block">
              <div className="eyebrow"><span>RUN-1842</span><span className="eyebrow-sep">/</span><RunStatus state={stopped ? "stopped" : "running"} /></div>
              <h1>Fix login redirect loop</h1>
              <div className="target-line">
                <span>waymark/web</span><GitBranch size={12} /><span>auto/fix-login-redirect</span>
                <a href="#session-1">#142 <ArrowUpRight size={11} /></a>
              </div>
            </div>
            <div className="head-actions">
              <button className="secondary-button"><GitBranch size={14} /> Fork</button>
              <button className="stop-button" onClick={() => setStopped(true)} disabled={stopped}>
                <CircleStop size={14} /> {stopped ? "Stopped" : "Stop"}
              </button>
            </div>
          </header>

          <div
            className="transcript"
            ref={viewportRef}
            onMouseDown={pauseFollowing}
            onKeyDown={pauseFollowing}
            onTouchStart={pauseFollowing}
            onCopy={pauseFollowing}
          >
            <article className="thread">
              <div className="session-card" id="session-1">
                <div className="session-heading">
                  <span className="session-number">01</span>
                  <div><strong>Agent session</strong><span>started 10:42:08 AM</span></div>
                  <div className="session-runtime"><Bot size={13} /> pi <span>·</span> opus 4.1 <span>·</span> Daytona</div>
                </div>
                <p>Resolve issue #142: users sometimes get caught in a redirect loop after signing in from an expired invite link.</p>
                {showMore && <p className="prompt-more">Reproduce the failure, add a regression test, and preserve the intended destination after authentication. Run the focused auth test suite before finishing.</p>}
                <div className="session-footer">
                  <span><GitBranch size={12} /> new from main</span>
                  <span><Link2 size={12} /> browser</span>
                  <button onClick={() => setShowMore((v) => !v)}>{showMore ? "Show less" : "Full prompt"} <ChevronDown size={11} /></button>
                </div>
              </div>

              <div className="orchestrator-group">
                <OrchestratorEvent time="+0.0s">Session accepted</OrchestratorEvent>
                <OrchestratorEvent time="+1.4s">Daytona workspace ready · branch mounted</OrchestratorEvent>
                <button className="orchestrator-more" onClick={() => setOrchestratorOpen((v) => !v)}>
                  <ChevronRight size={12} className={orchestratorOpen ? "rotated" : ""} />
                  {orchestratorOpen ? "Hide orchestration details" : "3 more orchestration events"}
                </button>
                {orchestratorOpen && (
                  <div className="orchestrator-extra">
                    <OrchestratorEvent time="+1.6s">Secrets scoped to repository</OrchestratorEvent>
                    <OrchestratorEvent time="+2.1s">Agent process attached</OrchestratorEvent>
                    <OrchestratorEvent time="+2.3s">Transcript stream opened</OrchestratorEvent>
                  </div>
                )}
              </div>

              <section className="agent-turn">
                <div className="turn-rail"><span><Bot size={14} /></span><i /></div>
                <div className="turn-body">
                  <div className="turn-label"><strong>Agent</strong><span>10:42:11 AM</span></div>
                  <div className="thinking">
                    <button><ChevronDown size={13} /> Thinking · 18s</button>
                    <p>I need to trace the invite callback and the post-auth redirect persistence. First I’ll inspect the route and existing tests, then reproduce the loop with the smallest focused test.</p>
                  </div>

                  <div className="tool-call">
                    <div className="tool-title">
                      <span className="tool-icon"><Search size={13} /></span>
                      <span><strong>Search files</strong><small>Find redirect and invite handling</small></span>
                      <span className="tool-time">0.3s</span>
                    </div>
                    <code>rg -n "redirectTo|inviteToken|returnTo" src</code>
                  </div>

                  <p className="agent-copy">The invite callback writes <code>returnTo</code> before authentication, but the login route reads it without clearing the stale invite query. That sends the user back through the callback and recreates the same value.</p>

                  <div className="tool-call expanded">
                    <div className="tool-title">
                      <span className="tool-icon file"><FileCode2 size={13} /></span>
                      <span><strong>Edit</strong><small>src/auth/redirect.ts</small></span>
                      <span className="tool-time">2 changes</span>
                    </div>
                    <div className="diff">
                      <div className="diff-line context"><span>42</span><span>42</span><code>const destination = sessionStorage.getItem(RETURN_TO);</code></div>
                      <div className="diff-line removed"><span>43</span><span></span><code>navigate(destination ?? "/");</code></div>
                      <div className="diff-line added"><span></span><span>43</span><code>sessionStorage.removeItem(RETURN_TO);</code></div>
                      <div className="diff-line added"><span></span><span>44</span><code>navigate(stripInviteParams(destination) ?? "/");</code></div>
                    </div>
                  </div>

                  <div className="thinking compact">
                    <button><ChevronDown size={13} /> Thinking · 7s</button>
                    <p>The state must be consumed before navigation. I’ll add the expired-invite case and verify normal deep links still work.</p>
                  </div>

                  <div className="tool-call">
                    <div className="tool-title">
                      <span className="tool-icon command"><Wrench size={13} /></span>
                      <span><strong>Run command</strong><small>Focused authentication tests</small></span>
                      <span className="tool-time">1.2s</span>
                    </div>
                    <code>npm test -- src/auth/redirect.test.ts src/routes/login.test.ts</code>
                    <CodeResult />
                  </div>

                  <p className="agent-copy">The redirect state is now consumed atomically and invite-only parameters are removed before navigation. The existing deep-link behavior is unchanged, and the regression is covered by the focused auth suite.</p>

                  {!stopped && (
                    <div className="active-step">
                      <span className="live-glyph"><Braces size={13} /></span>
                      <span><strong>Inspecting changes</strong><small>Reviewing the final diff for unrelated edits</small></span>
                      <span className="streaming-dots"><i /><i /><i /></span>
                    </div>
                  )}
                </div>
              </section>
              <div ref={endRef} aria-hidden="true" />
            </article>
          </div>

          {!following && !stopped && (
            <button className="jump-latest" onClick={jumpToLatest}>
              <span className="live-pulse" /> Agent is working
              <span className="jump-separator" />
              Jump to latest <ArrowDown size={13} />
            </button>
          )}

          <div className="composer">
            <div className="composer-box">
              <textarea
                value={composer}
                onChange={(e) => setComposer(e.target.value)}
                placeholder="Continue this conversation…"
                aria-label="Continue this conversation"
                rows={1}
              />
              <div className="composer-row">
                <button className="runtime-chip"><Bot size={12} /> pi · opus 4.1 <ChevronDown size={11} /></button>
                <span>Inherited from session 01</span>
                <button className="send-button" disabled={!composer.trim()}><ArrowUpRight size={15} /></button>
              </div>
            </div>
          </div>
        </section>
        )}
      </div>
    </main>
  );
}

export { App };
