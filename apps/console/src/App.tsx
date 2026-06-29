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
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

type RunState = "running" | "ready" | "failed" | "queued" | "stopped";
type BackendKind = "local" | "container" | "daytona";
type ProviderKind = "pi" | "claude-subscription" | "codex";
type Target = { kind: "local"; repoPath: string; branch: string } | { kind: "remote"; repo: string; issue?: number; branch: string };

interface AgentSessionSettings {
  backend: string;
  target: Target;
  provider: string;
  model: string;
  modelParams?: Record<string, unknown>;
  agent: string;
  carryContext?: string;
}

interface Prompt {
  persona: string;
  task: string;
  carryContext?: string;
  operatorNotes?: string;
  images?: string[];
  assembled: string;
}

interface AgentSession {
  id: string;
  conversationId: string;
  settings: AgentSessionSettings;
  prompt?: Prompt;
  status: "pending" | "starting" | "running" | "done" | "no-change" | "failed" | "stopped";
  startedAt?: string;
  finishedAt?: string;
  output?: Record<string, unknown>;
  error?: string;
}

interface Conversation {
  id: string;
  title: string;
  target: Target;
  sessionIds: string[];
  createdAt: string;
  updatedAt: string;
}

interface EventRecord {
  ts: string;
  type: string;
  conversationId: string;
  sessionId?: string;
  data?: Record<string, unknown>;
}

interface TimelineEntry {
  ts: string;
  source: "orchestrator" | "backend" | "agent" | "workload" | "workflow";
  level: "debug" | "info" | "warn" | "error";
  sessionId?: string;
  message: string;
  data?: Record<string, unknown>;
  relMs: number;
  rel: string;
}

interface RenderedConversation {
  conversation: Conversation;
  sessions: AgentSession[];
  events: EventRecord[];
  timeline: { t0: string | null; entries: TimelineEntry[] };
}

interface OptionsPayload {
  backends: BackendKind[];
  providers: Array<{ id: ProviderKind; models: string[] }>;
  skills: Array<{ id: string; requires?: Record<string, unknown> }>;
}

interface LaunchForm {
  title: string;
  repoPath: string;
  branch: string;
  newBranch: boolean;
  branchName: string;
  provider: ProviderKind;
  model: string;
  backend: BackendKind;
  agent: string;
  prompt: string;
  publish: boolean;
}

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, "") ?? "";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers, cache: "no-store" });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      // keep status text
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

const fallbackOptions: OptionsPayload = {
  backends: ["local", "container", "daytona"],
  providers: [
    { id: "pi", models: ["anthropic/claude-haiku-4.5", "anthropic/claude-sonnet-4.5"] },
    { id: "claude-subscription", models: ["sonnet", "opus"] },
  ],
  skills: [{ id: "browser", requires: { backendCapabilities: ["browser"] } }],
};

function targetLabel(target: Target): string {
  if (target.kind === "local") return target.repoPath.split("/").filter(Boolean).at(-1) ?? target.repoPath;
  return target.issue ? `${target.repo} #${target.issue}` : target.repo;
}

function targetBranch(target: Target): string {
  return target.branch;
}

function providerLabel(provider: string): string {
  return provider === "claude-subscription" ? "claude" : provider;
}

function backendLabel(backend: string): string {
  return backend === "daytona" ? "Daytona" : backend;
}

function shortId(id: string): string {
  return id.replace(/^conv-/, "").slice(0, 12).toUpperCase();
}

function timeAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function formatClock(iso?: string): string {
  if (!iso) return "pending";
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
}

function eventTerminal(type: string): boolean {
  return ["session_finished", "session_failed", "published", "publish_failed"].includes(type);
}

function deriveRunState(conv: Conversation, rendered?: RenderedConversation | null): RunState {
  const events = rendered?.events ?? [];
  const latest = [...events].reverse().find((e) => e.sessionId || eventTerminal(e.type));
  if (!conv.sessionIds.length) return "queued";
  if (latest?.type === "session_failed" || latest?.type === "publish_failed") return "failed";
  if (latest?.type === "session_finished" || latest?.type === "published") return "ready";
  const latestSession = rendered?.sessions.at(-1);
  if (latestSession?.status === "failed") return "failed";
  if (latestSession?.status === "stopped") return "stopped";
  if (latestSession?.status === "done" || latestSession?.status === "no-change") return "ready";
  return "running";
}

function latestSessionTerminal(rendered: RenderedConversation | null): boolean {
  if (!rendered) return true;
  const state = deriveRunState(rendered.conversation, rendered);
  return state === "ready" || state === "failed" || state === "stopped";
}

function lastPublishUrl(events: EventRecord[]): string | undefined {
  for (const event of [...events].reverse()) {
    const url = event.data?.prUrl;
    if (typeof url === "string") return url;
  }
  return undefined;
}

function RunStatus({ state }: { state: RunState }) {
  return (
    <span className={`run-status ${state}`}>
      <span className="status-dot" />
      {state}
    </span>
  );
}

function OrchestratorEvent({ children, time, level = "info" }: { children: ReactNode; time: string; level?: string }) {
  return (
    <div className={`orchestrator-event ${level}`}>
      <span className="event-time">{time}</span>
      <span className="event-mark"><Check size={11} strokeWidth={2.5} /></span>
      <span>{children}</span>
    </div>
  );
}

function CodeResult({ entry }: { entry: TimelineEntry }) {
  const exitCode = typeof entry.data?.exitCode === "number" ? `exit ${entry.data.exitCode}` : entry.level;
  const stdout = typeof entry.data?.stdout === "string" ? entry.data.stdout : entry.message;
  const stderr = typeof entry.data?.stderr === "string" ? entry.data.stderr : "";
  return (
    <div className="tool-result">
      <div className="result-header">
        <div><Terminal size={14} /> Result</div>
        <span>{exitCode}</span>
      </div>
      <pre>
        {stdout}
        {stderr ? `\n${stderr}` : ""}
      </pre>
    </div>
  );
}

function FieldInput({
  label,
  value,
  icon,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  icon: ReactNode;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <label className="field-button field-input">
      <span className="field-icon">{icon}</span>
      <span>
        <small>{label}</small>
        <input value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
      </span>
    </label>
  );
}

function FieldSelect<T extends string>({
  label,
  value,
  icon,
  options,
  onChange,
}: {
  label: string;
  value: T;
  icon: ReactNode;
  options: T[];
  onChange: (value: T) => void;
}) {
  return (
    <label className="field-button field-input">
      <span className="field-icon">{icon}</span>
      <span>
        <small>{label}</small>
        <select value={value} onChange={(event) => onChange(event.target.value as T)}>
          {options.map((option) => <option value={option} key={option}>{option}</option>)}
        </select>
      </span>
      <ChevronDown size={13} />
    </label>
  );
}

function EmptyIssues() {
  return (
    <div className="issue-empty">
      <Github size={15} />
      <strong>Issue discovery is not wired yet.</strong>
      <p>Use a local checkout path and paste the issue context into the prompt. The M4 API keeps this column real instead of backing it with fake data.</p>
    </div>
  );
}

function NewRunView({
  options,
  onLaunch,
}: {
  options: OptionsPayload;
  onLaunch: (form: LaunchForm) => Promise<void>;
}) {
  const [form, setForm] = useState<LaunchForm>({
    title: "New agent run",
    repoPath: "",
    branch: "main",
    newBranch: true,
    branchName: "auto/m4-console-run",
    provider: "pi",
    model: options.providers[0]?.models[0] ?? "anthropic/claude-haiku-4.5",
    backend: "local",
    agent: "generic",
    prompt: "",
    publish: false,
  });
  const [skills, setSkills] = useState(["browser"]);
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const providerModels = options.providers.find((p) => p.id === form.provider)?.models ?? [form.model];
  const branchTarget = form.newBranch ? form.branchName : form.branch;

  const patch = (next: Partial<LaunchForm>) => setForm((current) => ({ ...current, ...next }));

  const submit = async () => {
    setLaunching(true);
    setError(null);
    try {
      await onLaunch({ ...form, branchName: branchTarget });
    } catch (err) {
      setError(String(err));
    } finally {
      setLaunching(false);
    }
  };

  return (
    <section className="launch-view">
      <header className="launch-head">
        <div>
          <div className="eyebrow">NEW CONVERSATION</div>
          <h1>Start an agent run</h1>
          <p>Choose the target and execution context, then describe the outcome.</p>
        </div>
        <span className="draft-state">Browser draft</span>
      </header>

      <div className="launch-body">
        <div className="launch-main">
          <section className="launch-section">
            <div className="section-heading"><span>01</span><div><h2>Target</h2><p>Where the work should land.</p></div></div>
            <div className="field-grid target-fields">
              <FieldInput label="Local checkout" value={form.repoPath} onChange={(repoPath) => patch({ repoPath })} icon={<Github size={14} />} placeholder="/Users/caleb/code/project" />
              <FieldInput label="Base branch" value={form.branch} onChange={(branch) => patch({ branch })} icon={<GitBranch size={14} />} />
            </div>
            <label className="branch-toggle">
              <input type="checkbox" checked={form.newBranch} onChange={(event) => patch({ newBranch: event.target.checked })} />
              <span className="toggle-track"><i /></span>
              <span><strong>Create a new branch</strong><small>{branchTarget}</small></span>
            </label>
            {form.newBranch && (
              <div className="field-grid single-field">
                <FieldInput label="New branch name" value={form.branchName} onChange={(branchName) => patch({ branchName })} icon={<GitBranch size={14} />} />
              </div>
            )}
          </section>

          <section className="launch-section">
            <div className="section-heading"><span>02</span><div><h2>Agent session</h2><p>How and where the agent runs.</p></div></div>
            <div className="field-grid runtime-fields">
              <FieldSelect label="Provider" value={form.provider} options={options.providers.map((p) => p.id)} onChange={(provider) => patch({ provider, model: options.providers.find((p) => p.id === provider)?.models[0] ?? form.model })} icon={<Bot size={14} />} />
              <FieldSelect label="Model" value={form.model} options={providerModels} onChange={(model) => patch({ model })} icon={<Bot size={14} />} />
              <FieldSelect label="Backend" value={form.backend} options={options.backends} onChange={(backend) => patch({ backend })} icon={<Cloud size={14} />} />
              <FieldInput label="Agent" value={form.agent} onChange={(agent) => patch({ agent })} icon={<Bot size={14} />} />
            </div>
            <div className="skill-row">
              <span className="field-label">Skills</span>
              {skills.map((skill) => (
                <span className="skill-chip" key={skill}><Link2 size={11} />{skill}<button aria-label={`Remove ${skill}`} onClick={() => setSkills((current) => current.filter((item) => item !== skill))}><X size={10} /></button></span>
              ))}
              <button className="add-skill" onClick={() => setSkills((current) => current.includes("browser") ? current : [...current, "browser"])}><Plus size={11} /> Add skill</button>
              <span className="capability-note"><Box size={11} /> Capability filtering comes from /api/options</span>
            </div>
          </section>

          <section className="launch-section prompt-section">
            <div className="section-heading"><span>03</span><div><h2>Prompt</h2><p>Give the agent a clear outcome and useful constraints.</p></div></div>
            <div className="prompt-editor">
              <textarea
                value={form.prompt}
                onChange={(event) => patch({ prompt: event.target.value, title: event.target.value.split("\n")[0]?.slice(0, 80) || form.title })}
                placeholder="Describe what you want the agent to change…"
                aria-label="Agent prompt"
              />
              <div className="prompt-toolbar">
                <button type="button"><ImagePlus size={14} /> Add images</button>
                <span>Paste screenshots support is reserved for artifact plumbing</span>
                <span className="prompt-count">{form.prompt.length}</span>
              </div>
            </div>
          </section>

          {error && <div className="form-error">{error}</div>}

          <div className="launch-footer">
            <div className="launch-summary">
              <span><FolderGit2 size={13} /> {form.repoPath ? targetLabel({ kind: "local", repoPath: form.repoPath, branch: branchTarget }) : "local checkout"}</span>
              <span><Bot size={13} /> {providerLabel(form.provider)} · {form.model}</span>
              <span><Cloud size={13} /> {backendLabel(form.backend)}</span>
            </div>
            <button className="launch-button" disabled={!form.prompt.trim() || !form.repoPath.trim() || launching} onClick={submit}>
              {launching ? "Launching…" : "Launch run"} <span>⌘↵</span><ArrowUpRight size={14} />
            </button>
          </div>
        </div>

        <aside className="issues-panel">
          <div className="issues-head">
            <div><span>Open issues</span><b>0</b></div>
            <button aria-label="Search issues"><Search size={14} /></button>
          </div>
          <p>Issue discovery is an API concern; the column stays honest until it exists.</p>
          <EmptyIssues />
        </aside>
      </div>
    </section>
  );
}

function SessionCard({ session, index }: { session: AgentSession; index: number }) {
  const [showMore, setShowMore] = useState(index === 0);
  const promptText = session.prompt?.task || session.prompt?.assembled || "Session accepted; waiting for the runner to persist the prompt.";
  return (
    <div className="session-card" id={session.id}>
      <div className="session-heading">
        <span className="session-number">{String(index + 1).padStart(2, "0")}</span>
        <div><strong>Agent session</strong><span>started {formatClock(session.startedAt)}</span></div>
        <div className="session-runtime"><Bot size={13} /> {providerLabel(session.settings.provider)} <span>·</span> {session.settings.model} <span>·</span> {backendLabel(session.settings.backend)}</div>
      </div>
      <p>{showMore ? promptText : `${promptText.slice(0, 180)}${promptText.length > 180 ? "…" : ""}`}</p>
      {session.error && <p className="prompt-more">Error: {session.error}</p>}
      <div className="session-footer">
        <span><GitBranch size={12} /> {targetBranch(session.settings.target)}</span>
        <span><Link2 size={12} /> {session.status}</span>
        <button onClick={() => setShowMore((v) => !v)}>{showMore ? "Collapse prompt" : "Full prompt"} <ChevronDown size={11} /></button>
      </div>
    </div>
  );
}

function LogEntryView({ entry }: { entry: TimelineEntry }) {
  if (entry.source === "orchestrator" || entry.source === "backend" || entry.source === "workflow") {
    return <OrchestratorEvent time={entry.rel} level={entry.level}>{entry.message}</OrchestratorEvent>;
  }

  if (entry.source === "workload") {
    return (
      <div className="tool-call">
        <div className="tool-title">
          <span className="tool-icon command"><Wrench size={13} /></span>
          <span><strong>Workload</strong><small>{entry.level}</small></span>
          <span className="tool-time">{entry.rel}</span>
        </div>
        <CodeResult entry={entry} />
      </div>
    );
  }

  const kind = typeof entry.data?.kind === "string" ? entry.data.kind : "";
  if (kind.includes("tool") || entry.message.startsWith("tool")) {
    return (
      <div className="tool-call">
        <div className="tool-title">
          <span className="tool-icon"><Search size={13} /></span>
          <span><strong>Tool</strong><small>{kind || entry.level}</small></span>
          <span className="tool-time">{entry.rel}</span>
        </div>
        <code>{entry.message}</code>
      </div>
    );
  }

  if (kind.includes("diff")) {
    return (
      <div className="tool-call expanded">
        <div className="tool-title">
          <span className="tool-icon file"><FileCode2 size={13} /></span>
          <span><strong>Diff</strong><small>{entry.level}</small></span>
          <span className="tool-time">{entry.rel}</span>
        </div>
        <code>{entry.message}</code>
      </div>
    );
  }

  if (kind.includes("thinking")) {
    return (
      <div className="thinking">
        <button><ChevronDown size={13} /> Thinking · {entry.rel}</button>
        <p>{entry.message}</p>
      </div>
    );
  }

  return <p className="agent-copy">{entry.message}</p>;
}

function TimelineForSession({ entries }: { entries: TimelineEntry[] }) {
  const [infraOpen, setInfraOpen] = useState(false);
  const infra = entries.filter((entry) => entry.source === "orchestrator" || entry.source === "backend" || entry.source === "workflow");
  const main = entries.filter((entry) => entry.source === "agent" || entry.source === "workload");
  const firstInfra = infra.slice(0, 2);
  const hiddenInfra = infra.slice(2);

  return (
    <>
      {infra.length > 0 && (
        <div className="orchestrator-group">
          {firstInfra.map((entry) => <LogEntryView entry={entry} key={`${entry.ts}-${entry.message}`} />)}
          {hiddenInfra.length > 0 && (
            <>
              <button className="orchestrator-more" onClick={() => setInfraOpen((v) => !v)}>
                <ChevronRight size={12} className={infraOpen ? "rotated" : ""} />
                {infraOpen ? "Hide orchestration details" : `${hiddenInfra.length} more orchestration events`}
              </button>
              {infraOpen && <div className="orchestrator-extra">{hiddenInfra.map((entry) => <LogEntryView entry={entry} key={`${entry.ts}-${entry.message}`} />)}</div>}
            </>
          )}
        </div>
      )}

      <section className="agent-turn">
        <div className="turn-rail"><span><Bot size={14} /></span><i /></div>
        <div className="turn-body">
          <div className="turn-label"><strong>Agent trace</strong><span>{main.length ? formatClock(main[0]?.ts) : "waiting"}</span></div>
          {main.length ? main.map((entry) => <LogEntryView entry={entry} key={`${entry.ts}-${entry.message}`} />) : (
            <div className="active-step">
              <span className="live-glyph"><Braces size={13} /></span>
              <span><strong>Waiting for transcript</strong><small>The session is accepted; logs will appear here as the runner emits them.</small></span>
              <span className="streaming-dots"><i /><i /><i /></span>
            </div>
          )}
        </div>
      </section>
    </>
  );
}

function ConversationView({
  rendered,
  onContinue,
  onRefresh,
}: {
  rendered: RenderedConversation;
  onContinue: (task: string, latest: AgentSession) => Promise<void>;
  onRefresh: () => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(false);
  const [composer, setComposer] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const state = deriveRunState(rendered.conversation, rendered);
  const latest = rendered.sessions.at(-1);
  const publishUrl = lastPublishUrl(rendered.events);

  const entriesBySession = useMemo(() => {
    const map = new Map<string, TimelineEntry[]>();
    for (const entry of rendered.timeline.entries) {
      const sid = entry.sessionId ?? rendered.sessions[0]?.id ?? "unknown";
      map.set(sid, [...(map.get(sid) ?? []), entry]);
    }
    return map;
  }, [rendered.sessions, rendered.timeline.entries]);

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
  }, [following, rendered.timeline.entries.length]);

  const jumpToLatest = () => {
    setFollowing(true);
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  };

  const submitContinue = async () => {
    if (!latest || !composer.trim()) return;
    setSending(true);
    setError(null);
    try {
      await onContinue(composer, latest);
      setComposer("");
      onRefresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="conversation">
      <header className="conversation-head">
        <div className="title-block">
          <div className="eyebrow"><span>{shortId(rendered.conversation.id)}</span><span className="eyebrow-sep">/</span><RunStatus state={state} /></div>
          <h1>{rendered.conversation.title}</h1>
          <div className="target-line">
            <span>{targetLabel(rendered.conversation.target)}</span><GitBranch size={12} /><span>{targetBranch(rendered.conversation.target)}</span>
            {publishUrl && <a href={publishUrl} target="_blank" rel="noreferrer">PR <ArrowUpRight size={11} /></a>}
          </div>
        </div>
        <div className="head-actions">
          <button className="secondary-button" disabled><GitBranch size={14} /> Fork</button>
          <button className="stop-button" disabled title="Stop requires orchestrator cancellation support">
            <CircleStop size={14} /> Stop
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
          {rendered.sessions.length ? rendered.sessions.map((session, index) => (
            <div className="session-block" key={session.id}>
              <SessionCard session={session} index={index} />
              <TimelineForSession entries={entriesBySession.get(session.id) ?? []} />
            </div>
          )) : (
            <div className="empty-state">
              <Terminal size={18} />
              <strong>No sessions yet.</strong>
              <p>Start a session from the composer to create a trace.</p>
            </div>
          )}
          <div ref={endRef} aria-hidden="true" />
        </article>
      </div>

      {!following && state === "running" && (
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
            <button className="runtime-chip" disabled><Bot size={12} /> {latest ? `${providerLabel(latest.settings.provider)} · ${latest.settings.model}` : "No session"} <ChevronDown size={11} /></button>
            <span>{error ?? (latest ? `Inherited from session ${String(rendered.sessions.length).padStart(2, "0")}` : "Start a session first")}</span>
            <button className="send-button" disabled={!composer.trim() || !latest || sending} onClick={submitContinue}><ArrowUpRight size={15} /></button>
          </div>
        </div>
      </div>
    </section>
  );
}

function App() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [rendered, setRendered] = useState<RenderedConversation | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    const match = window.location.pathname.match(/^\/conversations\/([^/]+)/);
    return match?.[1] ?? null;
  });
  const [view, setView] = useState<"conversation" | "new">(() => selectedId ? "conversation" : "new");
  const [options, setOptions] = useState<OptionsPayload>(fallbackOptions);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [runStates, setRunStates] = useState<Record<string, RunState>>({});

  const loadConversations = useCallback(async () => {
    const list = await api<Conversation[]>("/api/conversations");
    setConversations(list);
    const renderedList = await Promise.all(
      list.map((conv) => api<RenderedConversation>(`/api/conversations/${encodeURIComponent(conv.id)}`).catch(() => null)),
    );
    const nextStates: Record<string, RunState> = {};
    renderedList.forEach((item, index) => {
      const conv = list[index];
      if (conv) nextStates[conv.id] = item ? deriveRunState(conv, item) : conv.sessionIds.length ? "running" : "queued";
    });
    setRunStates(nextStates);
  }, []);

  const loadConversation = useCallback(async (id: string) => {
    const next = await api<RenderedConversation>(`/api/conversations/${encodeURIComponent(id)}`);
    setRendered(next);
  }, []);

  useEffect(() => {
    api<OptionsPayload>("/api/options").then(setOptions).catch(() => setOptions(fallbackOptions));
  }, []);

  useEffect(() => {
    loadConversations().catch((err) => setLoadError(String(err)));
  }, [loadConversations]);

  useEffect(() => {
    if (!selectedId) return;
    loadConversation(selectedId).catch((err) => setLoadError(String(err)));
  }, [loadConversation, selectedId]);

  useEffect(() => {
    const id = selectedId;
    if (!id || view !== "conversation") return;
    const interval = setInterval(() => {
      void loadConversation(id).then(() => loadConversations()).catch((err) => setLoadError(String(err)));
    }, latestSessionTerminal(rendered) ? 5000 : 1000);
    return () => clearInterval(interval);
  }, [loadConversation, loadConversations, rendered, selectedId, view]);

  const selectConversation = (id: string) => {
    setSelectedId(id);
    setView("conversation");
    window.history.pushState(null, "", `/conversations/${id}`);
  };

  const newRun = () => {
    setSelectedId(null);
    setRendered(null);
    setView("new");
    window.history.pushState(null, "", "/new");
  };

  const launch = async (form: LaunchForm) => {
    const branch = form.newBranch ? form.branchName : form.branch;
    const target: Target = { kind: "local", repoPath: form.repoPath, branch };
    const conv = await api<Conversation>("/api/conversations", {
      method: "POST",
      body: JSON.stringify({ title: form.title || form.prompt.split("\n")[0] || "Agent run", target }),
    });
    await api<{ sessionId: string }>(`/api/conversations/${encodeURIComponent(conv.id)}/sessions`, {
      method: "POST",
      body: JSON.stringify({
        settings: {
          backend: form.backend,
          provider: form.provider,
          model: form.model,
          agent: form.agent,
        },
        task: form.prompt,
        publish: form.publish,
      }),
    });
    await loadConversations();
    selectConversation(conv.id);
  };

  const continueConversation = async (task: string, latest: AgentSession) => {
    if (!rendered) return;
    await api<{ sessionId: string }>(`/api/conversations/${encodeURIComponent(rendered.conversation.id)}/sessions`, {
      method: "POST",
      body: JSON.stringify({
        settings: {
          backend: latest.settings.backend,
          provider: latest.settings.provider,
          model: latest.settings.model,
          agent: latest.settings.agent,
          carryContext: latest.settings.carryContext,
        },
        task,
      }),
    });
    await loadConversation(rendered.conversation.id);
    await loadConversations();
  };

  return (
    <main className="shell">
      <header className="topbar">
        <button className="project-switcher">
          <span className="project-avatar">A</span>
          <span><strong>Automations</strong><small>local orchestrator</small></span>
          <ChevronDown size={14} />
        </button>
        <div className="top-actions">
          <button className="icon-button" aria-label="Refresh" onClick={() => { void loadConversations(); if (selectedId) void loadConversation(selectedId); }}><Search size={16} /></button>
          <span className="key-hint">M4</span>
          <div className="top-divider" />
          <button className="icon-button" aria-label="More options"><MoreHorizontal size={17} /></button>
        </div>
      </header>

      <div className="workspace">
        <aside className="sidebar">
          <div className="sidebar-head">
            <span>Runs <b>{conversations.length}</b></span>
            <button className="icon-button" aria-label="Collapse runs"><PanelLeftClose size={15} /></button>
          </div>
          <nav className="run-list" aria-label="Runs">
            {conversations.map((conv) => {
              const isSelected = selectedId === conv.id && view === "conversation";
              const state = isSelected && rendered ? deriveRunState(conv, rendered) : runStates[conv.id] ?? (conv.sessionIds.length ? "running" : "queued");
              return (
                <button className={`run-row ${isSelected ? "selected" : ""}`} key={conv.id} onClick={() => selectConversation(conv.id)}>
                  <span className="run-title">{conv.title}</span>
                  <span className="run-meta"><RunStatus state={state} /><span>{timeAgo(conv.updatedAt)}</span></span>
                  <span className="run-repo">{targetLabel(conv.target)}<em>{targetBranch(conv.target)}</em></span>
                </button>
              );
            })}
          </nav>
          {loadError && <div className="sidebar-error">{loadError}</div>}
          <button className={`new-run ${view === "new" ? "active" : ""}`} onClick={newRun}><Play size={13} fill="currentColor" /> New run</button>
        </aside>

        {view === "new" ? (
          <NewRunView options={options} onLaunch={launch} />
        ) : rendered ? (
          <ConversationView rendered={rendered} onContinue={continueConversation} onRefresh={() => { if (selectedId) void loadConversation(selectedId); }} />
        ) : (
          <section className="conversation">
            <div className="empty-state loading">
              <Terminal size={18} />
              <strong>Loading conversation…</strong>
              <p>{loadError ?? "Fetching orchestrator state."}</p>
            </div>
          </section>
        )}
      </div>
    </main>
  );
}

export { App };
