import {
  ArrowDown,
  ArrowUpRight,
  Bot,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Cloud,
  Copy,
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
  RefreshCw,
  Search,
  Sparkles,
  Terminal,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

type RunState = "running" | "ready" | "failed" | "queued" | "stopped";
type BackendKind = "local" | "container" | "daytona";
type ProviderKind = "pi" | "claude-subscription" | "codex";
type Target = { kind: "local"; repoPath: string; branch: string; newBranch?: string } | { kind: "remote"; repo: string; issue?: number; branch: string; newBranch?: string };

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
  artifacts?: SessionArtifact[];
  error?: string;
}

interface SessionArtifact {
  kind: "image";
  name: string;
  caption?: string;
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
  targetKind: "local" | "remote";
  repoPath: string;
  org: string;
  repo: string;
  issue: string;
  branch: string;
  newBranch: boolean;
  branchName: string;
  provider: ProviderKind;
  model: string;
  backend: BackendKind;
  agent: string;
  prompt: string;
  publish: boolean;
  qaReview: boolean;
}

interface RobotPreset {
  id: string;
  name: string;
  provider: ProviderKind;
  model: string;
  backend: BackendKind;
  agent: string;
  skills: string[];
  /** id of the default instruction (system prompt) this robot remembers, if any */
  instructionId?: string;
}

/** A named, reusable system prompt — server-owned (see @automations/core Instruction). */
interface Instruction {
  id: string;
  name: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

interface LocalRecent {
  path: string;
  selectedAt: string;
}

interface LocalBrowseEntry {
  name: string;
  path: string;
  isGit: boolean;
}

interface LocalBrowseRoot {
  label: string;
  path: string;
}

interface LocalBrowsePayload {
  current: string;
  name: string;
  parent: string | null;
  isGit: boolean;
  entries: LocalBrowseEntry[];
  roots: LocalBrowseRoot[];
  recents: LocalRecent[];
}

interface NativeFolderPayload {
  path?: string;
  recents?: LocalRecent[];
  cancelled?: boolean;
  error?: string;
}

interface BranchRecent {
  repoPath: string;
  branch: string;
  selectedAt: string;
}

interface BranchOption {
  name: string;
  current: boolean;
  remote: boolean;
  local: boolean;
}

interface BranchBrowsePayload {
  repoPath: string;
  current: string;
  branches: BranchOption[];
  recents: BranchRecent[];
}

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, "") ?? "";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers, cache: "no-store", credentials: "same-origin" });
  if (!res.ok) {
    // Session expired or missing — let the auth gate take over.
    if (res.status === 401) window.dispatchEvent(new Event("auth:unauthorized"));
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

const ROBOT_PRESETS_KEY = "console.robotPresets";

function loadRobotPresets(): RobotPreset[] {
  try {
    const raw = localStorage.getItem(ROBOT_PRESETS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveRobotPresets(presets: RobotPreset[]) {
  try {
    localStorage.setItem(ROBOT_PRESETS_KEY, JSON.stringify(presets));
  } catch {
    // storage unavailable (private mode, quota, etc.) — presets stay in-memory for this session
  }
}

const ACTIVE_ROBOT_PRESET_KEY = "console.activeRobotPresetId";
const CODE_SETTINGS_KEY = "console.codeSettings";

type SavedCodeSettings = Pick<
  LaunchForm,
  "targetKind" | "repoPath" | "org" | "repo" | "issue" | "branch" | "newBranch" | "branchName" | "publish"
>;

function loadCodeSettings(): SavedCodeSettings | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(CODE_SETTINGS_KEY) ?? "null") as Partial<SavedCodeSettings> | null;
    if (!parsed || (parsed.targetKind !== "local" && parsed.targetKind !== "remote")) return null;
    return {
      targetKind: parsed.targetKind,
      repoPath: typeof parsed.repoPath === "string" ? parsed.repoPath : "",
      org: typeof parsed.org === "string" ? parsed.org : "",
      repo: typeof parsed.repo === "string" ? parsed.repo : "",
      issue: typeof parsed.issue === "string" ? parsed.issue : "",
      branch: typeof parsed.branch === "string" && parsed.branch ? parsed.branch : "main",
      newBranch: typeof parsed.newBranch === "boolean" ? parsed.newBranch : true,
      branchName: typeof parsed.branchName === "string" && parsed.branchName ? parsed.branchName : "auto/m4-console-run",
      publish: typeof parsed.publish === "boolean" ? parsed.publish : true,
    };
  } catch {
    return null;
  }
}

function saveCodeSettings(form: LaunchForm): void {
  try {
    const saved: SavedCodeSettings = {
      targetKind: form.targetKind,
      repoPath: form.repoPath,
      org: form.org,
      repo: form.repo,
      issue: form.issue,
      branch: form.branch,
      newBranch: form.newBranch,
      branchName: form.branchName,
      publish: form.publish,
    };
    localStorage.setItem(CODE_SETTINGS_KEY, JSON.stringify(saved));
  } catch {
    // Storage can be unavailable in private browsing; the current run still works.
  }
}

function loadActiveRobotPresetId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_ROBOT_PRESET_KEY);
  } catch {
    return null;
  }
}

function saveActiveRobotPresetId(id: string | null) {
  try {
    if (id) localStorage.setItem(ACTIVE_ROBOT_PRESET_KEY, id);
    else localStorage.removeItem(ACTIVE_ROBOT_PRESET_KEY);
  } catch {
    // storage unavailable — active preset just won't survive a reload this session
  }
}

function modelShort(model: string): string {
  return model.split("/").pop() || model;
}

// Primary-action copy is derived from the run contract, not hard-coded into the
// button. Add future run intents (for example, answer-only) here as their form
// variables become explicit.
function runActionCopy(form: LaunchForm): { idle: string; busy: string } {
  if (form.publish) return { idle: "Draft PR", busy: "Drafting PR…" };
  if (form.qaReview) return { idle: "Run QA", busy: "Running QA…" };
  return { idle: "Run agent", busy: "Starting agent…" };
}

function targetLabel(target: Target): string {
  if (target.kind === "local") return target.repoPath.split("/").filter(Boolean).at(-1) ?? target.repoPath;
  return target.issue ? `${target.repo} #${target.issue}` : target.repo;
}

function targetBranch(target: Target): string {
  return target.newBranch ?? target.branch;
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

function publishEventFor(events: EventRecord[], sessionId: string): EventRecord | undefined {
  return [...events].reverse().find(
    (e) => (e.type === "published" || e.type === "publish_failed") && e.sessionId === sessionId,
  );
}

const PUBLISH_SKIP_LABEL: Record<string, string> = {
  "head-equals-base": "no PR — head equals base",
  "no-change": "agent made no changes",
  "no-origin": "checkout has no GitHub origin",
  "origin-mismatch": "checkout origin did not match the selected repository",
  "no-token": "no GitHub token (gh auth)",
  "push-failed": "push failed",
  "pr-failed": "PR creation failed",
};

function SessionArtifacts({ conversationId, sessionId, artifacts }: { conversationId: string; sessionId: string; artifacts: SessionArtifact[] }) {
  if (!artifacts.length) return null;
  return (
    <div className="artifact-strip">
      {artifacts.map((artifact) => {
        const src = `${API_BASE}/api/conversations/${encodeURIComponent(conversationId)}/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifact.name)}`;
        return (
          <figure className="artifact-card" key={artifact.name}>
            <a href={src} target="_blank" rel="noreferrer"><img src={src} alt={artifact.caption ?? artifact.name} loading="lazy" /></a>
            {artifact.caption && <figcaption>{artifact.caption}</figcaption>}
          </figure>
        );
      })}
    </div>
  );
}

function PublishCard({ event, target }: { event: EventRecord; target: Target }) {
  const data = event.data ?? {};
  const pushed = data.pushed === true;
  const branch = typeof data.branch === "string" ? data.branch : undefined;
  const [copied, setCopied] = useState(false);
  const copyBranch = async () => {
    if (!branch) return;
    try {
      await navigator.clipboard.writeText(branch);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };
  const branchUrl = typeof data.branchUrl === "string"
    ? data.branchUrl
    : pushed && branch && target.kind === "remote"
      ? `https://github.com/${target.repo}/tree/${branch.split("/").map(encodeURIComponent).join("/")}`
      : undefined;
  const prUrl = typeof data.prUrl === "string" ? data.prUrl : undefined;
  const comments = typeof data.commentsPosted === "number" ? data.commentsPosted : 0;
  const skipped = typeof data.skipped === "string" ? data.skipped : undefined;
  const error = typeof data.error === "string" ? data.error : undefined;
  // A non-push with only a benign skip reason (no changes, etc.) is informational,
  // not a failure — keep it muted rather than red.
  const failed = !pushed && (Boolean(error) || skipped === "push-failed" || skipped === "pr-failed");
  const benign = !pushed && !failed;

  const detail = [
    !failed && comments > 0 ? `${comments} comment${comments === 1 ? "" : "s"}` : "",
    skipped ? PUBLISH_SKIP_LABEL[skipped] ?? skipped : "",
    error ?? "",
  ].filter(Boolean).join(" · ");

  return (
    <div className={`publish-card${failed ? " failed" : ""}${benign ? " benign" : ""}`}>
      <span className="publish-icon">{failed ? <CircleStop size={14} /> : <GitBranch size={14} />}</span>
      <div className="publish-body">
        <strong>{failed ? "Publish failed" : prUrl ? "Opened draft PR" : pushed ? "Pushed branch" : "Nothing published"}</strong>
        <small>{branch && <code>{branch}</code>}{branch && (
          <button className="branch-copy" onClick={() => void copyBranch()} title="Copy branch name" aria-label="Copy branch name">
            {copied ? <Check size={11} /> : <Copy size={11} />}
          </button>
        )}{branch && detail ? " · " : ""}{detail}</small>
      </div>
      {(branchUrl || prUrl) && (
        <div className="publish-links">
          {branchUrl && <a className="publish-link" href={branchUrl} target="_blank" rel="noreferrer">View branch <ArrowUpRight size={12} /></a>}
          {prUrl && <a className="publish-link" href={prUrl} target="_blank" rel="noreferrer">View PR <ArrowUpRight size={12} /></a>}
        </div>
      )}
    </div>
  );
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
  list,
}: {
  label: string;
  value: string;
  icon: ReactNode;
  onChange: (value: string) => void;
  placeholder?: string;
  list?: string;
}) {
  return (
    <label className="field-button field-input">
      <span className="field-icon">{icon}</span>
      <span>
        <small>{label}</small>
        <input value={value} placeholder={placeholder} list={list} onChange={(event) => onChange(event.target.value)} />
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
  render,
}: {
  label: string;
  value: T;
  icon: ReactNode;
  options: T[];
  onChange: (value: T) => void;
  render?: (value: T) => string;
}) {
  return (
    <label className="field-button field-input">
      <span className="field-icon">{icon}</span>
      <span>
        <small>{label}</small>
        <select value={value} onChange={(event) => onChange(event.target.value as T)}>
          {options.map((option) => <option value={option} key={option}>{render ? render(option) : option}</option>)}
        </select>
      </span>
      <ChevronDown size={13} />
    </label>
  );
}

// Like FieldSelect, but maps instruction id → name (value differs from label) and
// carries a "None" choice. Used for the run's system prompt and a robot's default.
function InstructionSelect({
  label,
  value,
  instructions,
  onChange,
}: {
  label: string;
  value: string | null;
  instructions: Instruction[];
  onChange: (id: string | null) => void;
}) {
  return (
    <label className="field-button field-input">
      <span className="field-icon"><FileCode2 size={14} /></span>
      <span>
        <small>{label}</small>
        <select value={value ?? ""} onChange={(event) => onChange(event.target.value || null)}>
          <option value="">None</option>
          {instructions.map((instruction) => (
            <option value={instruction.id} key={instruction.id}>{instruction.name}</option>
          ))}
        </select>
      </span>
      <ChevronDown size={13} />
    </label>
  );
}

function LocalCheckoutModal({
  initialPath,
  onClose,
  onChoose,
}: {
  initialPath: string;
  onClose: () => void;
  onChoose: (path: string) => void;
}) {
  const [path, setPath] = useState(initialPath || "");
  const [data, setData] = useState<LocalBrowsePayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (nextPath?: string) => {
    setLoading(true);
    setError(null);
    try {
      const query = nextPath ? `?path=${encodeURIComponent(nextPath)}` : "";
      const next = await api<LocalBrowsePayload>(`/api/local/browse${query}`);
      setData(next);
      setPath(next.current);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(initialPath);
  }, [initialPath, load]);

  const choose = async (chosen: string) => {
    await api<{ recents: LocalRecent[] }>("/api/local/recents", {
      method: "POST",
      body: JSON.stringify({ path: chosen }),
    });
    onChoose(chosen);
    onClose();
  };

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="folder-modal" role="dialog" aria-modal="true" aria-labelledby="folder-modal-title">
        <header className="folder-modal-head">
          <div>
            <div className="eyebrow">LOCAL CHECKOUT</div>
            <h2 id="folder-modal-title">Choose a folder</h2>
          </div>
          <button className="icon-button" aria-label="Close folder picker" onClick={onClose}><X size={16} /></button>
        </header>

        <div className="folder-path-row">
          <input value={path} onChange={(event) => setPath(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void load(path); }} aria-label="Folder path" />
          <button className="secondary-button" onClick={() => void load(path)}>Go</button>
          <button className="launch-button" disabled={!data} onClick={() => data && void choose(data.current)}>Use this folder</button>
        </div>

        {error && <div className="form-error folder-error">{error}</div>}

        <div className="folder-modal-body">
          <aside className="folder-rail">
            <div className="folder-section-title">Recent</div>
            {data?.recents.length ? data.recents.map((recent) => (
              <button className="folder-rail-row" key={recent.path} onClick={() => void choose(recent.path)}>
                <FolderGit2 size={12} />
                <span>{recent.path}</span>
              </button>
            )) : <p>No recent checkouts yet.</p>}

            <div className="folder-section-title">Locations</div>
            {data?.roots.map((root) => (
              <button className="folder-rail-row" key={root.path} onClick={() => void load(root.path)}>
                <ChevronRight size={12} />
                <span>{root.label}</span>
              </button>
            ))}
          </aside>

          <div className="folder-browser">
            <div className="folder-browser-head">
              <button className="secondary-button" disabled={!data?.parent} onClick={() => data?.parent && void load(data.parent)}>
                <ChevronRight className="rotated" size={13} /> Up
              </button>
              <span>{loading ? "Loading…" : data?.current}</span>
              {data?.isGit && <em>Git repo</em>}
            </div>
            <div className="folder-list">
              {data?.entries.map((entry) => (
                <button className={`folder-row ${entry.isGit ? "git" : ""}`} key={entry.path} onClick={() => void load(entry.path)} onDoubleClick={() => entry.isGit && void choose(entry.path)}>
                  <FolderGit2 size={14} />
                  <span><strong>{entry.name}</strong><small>{entry.path}</small></span>
                  {entry.isGit && <em>repo</em>}
                  <ChevronRight size={14} />
                </button>
              ))}
              {data && data.entries.length === 0 && <div className="folder-empty">No child folders here.</div>}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function BranchPickerModal({
  repoPath,
  selectedBranch,
  onClose,
  onChoose,
}: {
  repoPath: string;
  selectedBranch: string;
  onClose: () => void;
  onChoose: (branch: string) => void;
}) {
  const [data, setData] = useState<BranchBrowsePayload | null>(null);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!repoPath.trim()) {
      setError("Choose a local checkout first.");
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setData(await api<BranchBrowsePayload>(`/api/local/branches?repoPath=${encodeURIComponent(repoPath)}`));
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [repoPath]);

  useEffect(() => {
    void load();
  }, [load]);

  const choose = async (branch: string) => {
    await api<{ recents: BranchRecent[] }>("/api/local/branch-recents", {
      method: "POST",
      body: JSON.stringify({ repoPath, branch }),
    });
    onChoose(branch);
    onClose();
  };

  const filtered = (data?.branches ?? []).filter((branch) => branch.name.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="folder-modal branch-modal" role="dialog" aria-modal="true" aria-labelledby="branch-modal-title">
        <header className="folder-modal-head">
          <div>
            <div className="eyebrow">BASE BRANCH</div>
            <h2 id="branch-modal-title">Choose a branch</h2>
          </div>
          <button className="icon-button" aria-label="Close branch picker" onClick={onClose}><X size={16} /></button>
        </header>

        <div className="folder-path-row">
          <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="Filter all detected branches…" aria-label="Filter branches" />
          <button className="secondary-button" onClick={() => void load()}>Refresh</button>
          <button className="launch-button" disabled={!selectedBranch} onClick={() => void choose(selectedBranch)}>Use {selectedBranch || "branch"}</button>
        </div>

        {error && <div className="form-error folder-error">{error}</div>}

        <div className="folder-modal-body">
          <aside className="folder-rail">
            <div className="folder-section-title">Recent</div>
            {data?.recents.length ? data.recents.map((recent) => (
              <button className="folder-rail-row" key={`${recent.repoPath}:${recent.branch}`} onClick={() => void choose(recent.branch)}>
                <GitBranch size={12} />
                <span>{recent.branch}</span>
              </button>
            )) : <p>No recent branches for this checkout yet.</p>}

            <div className="folder-section-title">Repository</div>
            <p>{repoPath || "No local checkout selected."}</p>
            {data?.current && <button className="folder-rail-row" onClick={() => void choose(data.current)}><Check size={12} /><span>Current: {data.current}</span></button>}
          </aside>

          <div className="folder-browser">
            <div className="folder-browser-head">
              <span>{loading ? "Loading branches…" : `${filtered.length} branches detected`}</span>
              {data?.current && <em>{data.current}</em>}
            </div>
            <div className="folder-list">
              {filtered.map((branch) => (
                <button className={`folder-row branch-row ${branch.name === selectedBranch ? "selected" : ""}`} key={branch.name} onClick={() => void choose(branch.name)}>
                  <GitBranch size={14} />
                  <span><strong>{branch.name}</strong><small>{branch.current ? "current checkout" : branch.remote ? "remote branch" : "local branch"}</small></span>
                  {branch.current && <em>current</em>}
                  {branch.name === selectedBranch ? <Check size={14} /> : <ChevronRight size={14} />}
                </button>
              ))}
              {data && filtered.length === 0 && <div className="folder-empty">No matching branches.</div>}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

interface GithubIssue {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  updatedAt: string;
}
interface GithubIssuesPayload {
  repo: string;
  issues: GithubIssue[];
}

function issueAsPrompt(issue: GithubIssue): string {
  return `${issue.title} (#${issue.number})\n\n${issue.body || ""}`.trim();
}

// Open issues for the selected repo, with click-to-expand, an external link, and
// buttons to drop the issue into the prompt or copy it.
function IssuesPanel({ repo, onUse }: { repo: string; onUse: (issue: GithubIssue) => void }) {
  const [issues, setIssues] = useState<GithubIssue[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [copied, setCopied] = useState<number | null>(null);

  const load = useCallback(() => {
    if (!repo) { setIssues([]); return; }
    setLoading(true);
    setError(null);
    api<GithubIssuesPayload>(`/api/github/issues?repo=${encodeURIComponent(repo)}`)
      .then((payload) => setIssues(payload.issues))
      .catch((err) => { setIssues([]); setError(String(err)); })
      .finally(() => setLoading(false));
  }, [repo]);

  useEffect(() => { load(); }, [load]);

  const copy = async (issue: GithubIssue) => {
    try {
      await navigator.clipboard.writeText(`${issueAsPrompt(issue)}\n\n${issue.url}`);
      setCopied(issue.number);
      setTimeout(() => setCopied((n) => (n === issue.number ? null : n)), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <>
      <div className="issues-head">
        <div><span>Open issues</span><b>{issues.length}</b></div>
        <button className="issues-refresh" onClick={load} disabled={loading}><RefreshCw size={12} className={loading ? "spin" : ""} /> {loading ? "Refreshing…" : "Refresh"}</button>
      </div>
      {error ? (
        <p className="github-error">{error}</p>
      ) : loading && issues.length === 0 ? (
        <p>Loading issues…</p>
      ) : issues.length === 0 ? (
        <p>No open issues on {repo}.</p>
      ) : (
        <div className="issue-list">
          {issues.map((issue) => (
            <div className="issue-item" key={issue.number}>
              <button className={`issue-row ${open === issue.number ? "selected" : ""}`} onClick={() => setOpen((n) => (n === issue.number ? null : issue.number))}>
                <span className="issue-row-title"><b>#{issue.number}</b> {issue.title}</span>
                {issue.labels.length > 0 && <span className="issue-row-labels">{issue.labels.slice(0, 3).map((l) => <em key={l}>{l}</em>)}</span>}
              </button>
              {open === issue.number && (
                <div className="issue-detail">
                  {issue.body && <p>{issue.body.slice(0, 700)}{issue.body.length > 700 ? "…" : ""}</p>}
                  <div className="issue-actions">
                    <button onClick={() => onUse(issue)}><ArrowDown size={12} /> Use as prompt</button>
                    <button onClick={() => void copy(issue)}>{copied === issue.number ? <Check size={12} /> : <Copy size={12} />} Copy</button>
                    <a href={issue.url} target="_blank" rel="noreferrer"><ArrowUpRight size={12} /> Open</a>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

interface GithubOrgsPayload {
  orgs: string[];
  lastOrg: string | null;
  connectedOwners?: string[];
}
interface GithubReposPayload {
  org: string;
  repos: string[];
  fetchedAt: string;
  cached?: boolean;
  stale?: boolean;
  error?: string;
}

const ADD_ORG = " add-org";

// Organization + repository picker for GitHub targets. Defaults the org to the
// last-used (or the only saved one) so it rarely needs typing, and reads the
// host-cached repo list so the dropdown is populated without waiting on the network.
function GithubTargetPicker({
  org,
  repo,
  onChange,
}: {
  org: string;
  repo: string;
  onChange: (next: Partial<LaunchForm>) => void;
}) {
  const [orgs, setOrgs] = useState<string[]>([]);
  const [connectedOwners, setConnectedOwners] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [newOrg, setNewOrg] = useState("");
  const [savingOrg, setSavingOrg] = useState(false);
  const [repos, setRepos] = useState<string[]>([]);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    let active = true;
    api<GithubOrgsPayload>("/api/github/orgs")
      .then((payload) => {
        if (!active) return;
        setOrgs(payload.orgs);
        setConnectedOwners(payload.connectedOwners ?? []);
        if (payload.orgs.length === 0) setAdding(true);
        if (!org) {
          // Hosted SSO can return several organizations and has no host-local
          // "last used" value yet. Select the first imported owner so the form
          // is useful immediately instead of showing an empty selector.
          const fallback = payload.lastOrg ?? payload.orgs[0] ?? "";
          if (fallback) onChange({ org: fallback, repo: "" });
        }
      })
      .catch((err) => active && setError(String(err)));
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadRepos = useCallback((targetOrg: string, refresh = false, selectFirst = false) => {
    if (!targetOrg) { setRepos([]); setFetchedAt(null); return; }
    setLoadingRepos(true);
    setError(null);
    api<GithubReposPayload>(`/api/github/repos?org=${encodeURIComponent(targetOrg)}${refresh ? "&refresh=1" : ""}`)
      .then((payload) => {
        setRepos(payload.repos);
        setFetchedAt(payload.fetchedAt);
        setError(payload.error ?? null);
        // GitHub returns the accessible repository set for this installation.
        // Start with the first stable (alphabetically sorted) option only when
        // the caller asked to (selectFirst) — i.e. the user has not already
        // chosen or typed a repository, and this is not a manual refresh.
        if (selectFirst && payload.repos[0]) onChangeRef.current({ repo: payload.repos[0] });
      })
      .catch((err) => { setRepos([]); setError(String(err)); })
      .finally(() => setLoadingRepos(false));
  }, []);

  useEffect(() => { loadRepos(org, false, !repo); }, [org, loadRepos]);

  const saveOrg = async () => {
    const value = newOrg.trim();
    if (!value) return;
    setSavingOrg(true);
    setError(null);
    try {
      const payload = await api<GithubOrgsPayload>("/api/github/orgs", { method: "POST", body: JSON.stringify({ org: value }) });
      setOrgs(payload.orgs);
      setAdding(false);
      setNewOrg("");
      onChange({ org: value, repo: "" });
    } catch (err) {
      setError(String(err));
    } finally {
      setSavingOrg(false);
    }
  };

  const shortName = (full: string) => (org && full.startsWith(`${org}/`) ? full.slice(org.length + 1) : full);
  const repoName = shortName(repo);
  const repoOptions = repos.map(shortName);
  const setRepoName = (value: string) => {
    const trimmed = value.trim();
    onChange({ repo: !trimmed ? "" : trimmed.includes("/") || !org ? trimmed : `${org}/${trimmed}` });
  };

  return (
    <div className="github-target">
      {adding ? (
        <div className="github-add-org">
          <FieldInput label="New organization" value={newOrg} onChange={setNewOrg} icon={<Github size={14} />} placeholder="my-org" />
          <button className="org-save" disabled={!newOrg.trim() || savingOrg} onClick={() => void saveOrg()}>{savingOrg ? "Saving…" : "Save org"}</button>
          {orgs.length > 0 && <button className="org-icon-button" aria-label="Cancel" onClick={() => { setAdding(false); setNewOrg(""); }}><X size={13} /></button>}
        </div>
      ) : (
        <FieldSelect
          label="Organization"
          value={org || ADD_ORG}
          options={[...orgs, ADD_ORG]}
          onChange={(value) => (value === ADD_ORG ? setAdding(true) : onChange({ org: value, repo: "" }))}
          icon={<Github size={14} />}
          render={(value) => (value === ADD_ORG ? "+ Add organization…" : value)}
        />
      )}
      <div className="github-repo-row">
        <FieldSelect
          label={loadingRepos ? "Repository · loading…" : "Repository"}
          value={repoName}
          onChange={setRepoName}
          icon={<FolderGit2 size={14} />}
          options={repoOptions}
        />
        <button className="org-icon-button" aria-label="Refresh repositories" title="Refresh repository list" disabled={!org || loadingRepos} onClick={() => loadRepos(org, true)}>
          <RefreshCw size={13} className={loadingRepos ? "spin" : ""} />
        </button>
      </div>
      {error ? (
        <div>
          <p className="config-note github-error">{error}</p>
          {!connectedOwners.some((owner) => owner.toLowerCase() === org.toLowerCase()) ? (
            <a className="secondary-button github-connect" href={`${API_BASE}/api/github/install`}>
              <Github size={13} /> Connect repositories
            </a>
          ) : null}
        </div>
      ) : fetchedAt ? (
        <p className="config-note">{repos.length} repos · daytona backend clones the target</p>
      ) : (
        <p className="config-note">GitHub targets clone in the daytona backend.</p>
      )}
    </div>
  );
}

const HOLD_TO_EDIT_MS = 1200;
const HOLD_REVEAL_MS = 250;
const CURRENT_ROBOT_PROMPT = "__current-robot__";

function RobotTile({
  preset,
  active,
  options,
  instructions,
  onApply,
  onUpdate,
  onRemove,
  onManageInstruction,
}: {
  preset: RobotPreset;
  active: boolean;
  options: OptionsPayload;
  instructions: Instruction[];
  onApply: () => void;
  onUpdate: (next: RobotPreset) => void;
  onRemove: () => void;
  onManageInstruction: (presetId: string, instructionId: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [holdRatio, setHoldRatio] = useState(0);
  const [draft, setDraft] = useState<RobotPreset>(preset);
  const holdRaf = useRef<number | null>(null);
  const heldRef = useRef(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!editing) setDraft(preset);
  }, [preset, editing]);

  useEffect(() => {
    if (!editing) return;
    const handler = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setEditing(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [editing]);

  const stopHold = () => {
    if (holdRaf.current !== null) cancelAnimationFrame(holdRaf.current);
    holdRaf.current = null;
    setHoldRatio(0);
  };

  const startHold = () => {
    heldRef.current = false;
    const start = performance.now();
    const tick = () => {
      const elapsed = performance.now() - start;
      const ratio = Math.min(1, elapsed / HOLD_TO_EDIT_MS);
      setHoldRatio(elapsed >= HOLD_REVEAL_MS ? ratio : 0);
      if (ratio >= 1) {
        heldRef.current = true;
        holdRaf.current = null;
        setDraft(preset);
        setEditing(true);
        setHoldRatio(0);
        return;
      }
      holdRaf.current = requestAnimationFrame(tick);
    };
    holdRaf.current = requestAnimationFrame(tick);
  };

  const handlePointerUp = () => {
    const wasHeldToEdit = heldRef.current;
    stopHold();
    if (!wasHeldToEdit) onApply();
  };

  const draftProviderModels = options.providers.find((p) => p.id === draft.provider)?.models ?? [draft.model];

  const save = () => {
    if (!draft.name.trim()) return;
    onUpdate({ ...draft, name: draft.name.trim() });
    setEditing(false);
  };

  const remove = () => {
    setEditing(false);
    onRemove();
  };

  return (
    <div className="robot-tile-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`robot-tile ${active ? "active" : ""}`}
        title={`${preset.name} · ${modelShort(preset.model)}`}
        onPointerDown={startHold}
        onPointerUp={handlePointerUp}
        onPointerLeave={stopHold}
        onPointerCancel={stopHold}
      >
        <span
          className="robot-tile-remove"
          role="button"
          tabIndex={-1}
          aria-label={`Remove preset ${preset.name}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
        >
          <X size={9} />
        </span>
        <span className="robot-tile-icon"><Bot size={14} /></span>
        <strong>{preset.name}</strong>
        <small>{modelShort(preset.model)}</small>
        {holdRatio > 0 && <span className="robot-tile-hold" style={{ transform: `scaleX(${holdRatio})` }} />}
      </button>
      {!editing && <span className="robot-tile-hint">Hold to edit</span>}
      {editing && (
        <div className="robot-editor" role="dialog" aria-label={`Edit ${preset.name}`}>
          <div className="config-block-head"><h3>Edit preset</h3><p>Update the saved agent configuration.</p></div>
          <div className="field-grid single-field">
            <FieldInput label="Preset name" value={draft.name} onChange={(name) => setDraft((d) => ({ ...d, name }))} icon={<Bot size={14} />} />
          </div>
          <div className="field-grid runtime-fields">
            <FieldSelect label="Provider" value={draft.provider} options={options.providers.map((p) => p.id)} onChange={(provider) => setDraft((d) => ({ ...d, provider, model: options.providers.find((p) => p.id === provider)?.models[0] ?? d.model }))} icon={<Bot size={14} />} />
            <FieldSelect label="Model" value={draft.model} options={draftProviderModels} onChange={(model) => setDraft((d) => ({ ...d, model }))} icon={<Bot size={14} />} />
            <FieldSelect label="Backend" value={draft.backend} options={options.backends} onChange={(backend) => setDraft((d) => ({ ...d, backend }))} icon={<Cloud size={14} />} />
            <FieldInput label="Agent" value={draft.agent} onChange={(agent) => setDraft((d) => ({ ...d, agent }))} icon={<Bot size={14} />} />
          </div>
          <div className="skill-row">
            <span className="field-label">Skills</span>
            {draft.skills.map((skill) => (
              <span className="skill-chip" key={skill}><Link2 size={11} />{skill}<button aria-label={`Remove ${skill}`} onClick={() => setDraft((d) => ({ ...d, skills: d.skills.filter((s) => s !== skill) }))}><X size={10} /></button></span>
            ))}
            <button className="add-skill" onClick={() => setDraft((d) => (d.skills.includes("browser") ? d : { ...d, skills: [...d.skills, "browser"] }))}><Plus size={11} /> Add skill</button>
          </div>
          <button
            type="button"
            className="robot-prompt-row"
            onClick={() => {
              setEditing(false);
              onManageInstruction(preset.id, draft.instructionId ?? null);
            }}
          >
            <span className="robot-prompt-icon"><FileCode2 size={14} /></span>
            <span>
              <small>Prompt</small>
              <strong>
                {instructions.find((instruction) => instruction.id === draft.instructionId)?.name ?? "No system prompt"}
              </strong>
            </span>
            <span className="robot-prompt-action">{draft.instructionId ? "Edit" : "Create"} <ChevronRight size={13} /></span>
          </button>
          <div className="robot-editor-save">
            <button className="secondary-button robot-editor-delete" onClick={remove}><X size={12} /> Delete</button>
            <button className="org-save" disabled={!draft.name.trim()} onClick={save}>Save</button>
          </div>
        </div>
      )}
    </div>
  );
}

function AgentSettingsTile({
  form,
  patch,
  skills,
  setSkills,
  options,
  providerModels,
  backendOptions,
  isMatchedPreset,
  hasPresets,
  onSavePreset,
  instructions,
  instructionId,
  onManageInstruction,
}: {
  form: LaunchForm;
  patch: (next: Partial<LaunchForm>) => void;
  skills: string[];
  setSkills: (updater: (current: string[]) => string[]) => void;
  options: OptionsPayload;
  providerModels: string[];
  backendOptions: BackendKind[];
  isMatchedPreset: boolean;
  hasPresets: boolean;
  onSavePreset: (name: string) => void;
  instructions: Instruction[];
  instructionId: string | null;
  onManageInstruction: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [presetName, setPresetName] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const save = () => {
    const name = presetName.trim();
    if (!name) return;
    onSavePreset(name);
    setPresetName("");
  };

  return (
    <div className="robot-tile-wrap" ref={wrapRef}>
      <button
        type="button"
        className={`robot-tile robot-tile-edit ${hasPresets ? "robot-tile-add" : ""} ${open ? "open" : ""} ${!hasPresets && isMatchedPreset ? "active" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-label={hasPresets ? "Add a new agent preset" : "Agent settings"}
      >
        {hasPresets ? (
          <Plus size={20} />
        ) : (
          <>
            <span className="robot-tile-icon"><Bot size={14} /></span>
            <strong>{providerLabel(form.provider)}</strong>
            <small>{modelShort(form.model)}</small>
          </>
        )}
      </button>
      {open && (
        <div className="robot-editor" role="dialog" aria-label="Agent settings">
          <div className="config-block-head"><h3>Agent</h3><p>How and where the agent runs.</p></div>
          <div className="field-grid runtime-fields">
            <FieldSelect label="Provider" value={form.provider} options={options.providers.map((p) => p.id)} onChange={(provider) => patch({ provider, model: options.providers.find((p) => p.id === provider)?.models[0] ?? form.model })} icon={<Bot size={14} />} />
            <FieldSelect label="Model" value={form.model} options={providerModels} onChange={(model) => patch({ model })} icon={<Bot size={14} />} />
            <FieldSelect label="Backend" value={form.backend} options={backendOptions} onChange={(backend) => patch({ backend })} icon={<Cloud size={14} />} />
            <FieldInput label="Agent" value={form.agent} onChange={(agent) => patch({ agent })} icon={<Bot size={14} />} />
          </div>
          <div className="skill-row">
            <span className="field-label">Skills</span>
            {skills.map((skill) => (
              <span className="skill-chip" key={skill}><Link2 size={11} />{skill}<button aria-label={`Remove ${skill}`} onClick={() => setSkills((current) => current.filter((item) => item !== skill))}><X size={10} /></button></span>
            ))}
            <button className="add-skill" onClick={() => setSkills((current) => current.includes("browser") ? current : [...current, "browser"])}><Plus size={11} /> Add skill</button>
          </div>
          <button
            type="button"
            className="robot-prompt-row"
            onClick={() => {
              setOpen(false);
              onManageInstruction();
            }}
          >
            <span className="robot-prompt-icon"><FileCode2 size={14} /></span>
            <span>
              <small>Prompt</small>
              <strong>
                {instructions.find((instruction) => instruction.id === instructionId)?.name ?? "No system prompt"}
              </strong>
            </span>
            <span className="robot-prompt-action">{instructionId ? "Edit" : "Create"} <ChevronRight size={13} /></span>
          </button>
          <div className="robot-editor-save">
            <input
              value={presetName}
              onChange={(event) => setPresetName(event.target.value)}
              placeholder="Save as preset…"
              aria-label="Preset name"
              onKeyDown={(event) => { if (event.key === "Enter") save(); }}
            />
            <button className="org-save" disabled={!presetName.trim()} onClick={save}>Save</button>
          </div>
        </div>
      )}
    </div>
  );
}

function NewRunView({
  options,
  onLaunch,
  initial,
}: {
  options: OptionsPayload;
  onLaunch: (form: LaunchForm, persona?: string) => Promise<void>;
  initial?: Partial<LaunchForm> | undefined;
}) {
  const [presets, setPresets] = useState<RobotPreset[]>(() => loadRobotPresets());
  const [activePresetId, setActivePresetId] = useState<string | null>(() => {
    const id = loadActiveRobotPresetId();
    return id && presets.some((preset) => preset.id === id) ? id : null;
  });
  const lastUsedPreset = activePresetId ? presets.find((preset) => preset.id === activePresetId) : undefined;
  const [savedCodeSettings] = useState<SavedCodeSettings | null>(() => initial ? null : loadCodeSettings());
  const [codeDefaultsReady, setCodeDefaultsReady] = useState(() => !!initial || !!savedCodeSettings);

  const [form, setForm] = useState<LaunchForm>(() => ({
    title: "New agent run",
    targetKind: "local",
    repoPath: "",
    org: "",
    repo: "",
    issue: "",
    branch: "main",
    newBranch: true,
    branchName: "auto/m4-console-run",
    provider: lastUsedPreset?.provider ?? "pi",
    model: lastUsedPreset?.model ?? options.providers[0]?.models[0] ?? "anthropic/claude-haiku-4.5",
    backend: lastUsedPreset?.backend ?? (savedCodeSettings?.targetKind === "remote" ? "daytona" : "local"),
    agent: lastUsedPreset?.agent ?? "generic",
    prompt: "",
    publish: true,
    qaReview: false,
    ...(savedCodeSettings ?? {}),
    ...initial,
  }));
  const [skills, setSkills] = useState(() => (!initial && lastUsedPreset ? [...lastUsedPreset.skills] : ["browser"]));
  // The base branch we last auto-seeded from a repo's default, so a repo switch can
  // overwrite our own guess but never a base branch the operator typed by hand.
  const autoBranchRef = useRef<string | null>(null);

  // Instruction (system prompt) library — server-owned. `instructionBody` is the
  // live text sent as the run's persona; it diverges from the saved copy once
  // edited or generated, until re-saved.
  const [instructions, setInstructions] = useState<Instruction[]>([]);
  const [selectedInstructionId, setSelectedInstructionId] = useState<string | null>(lastUsedPreset?.instructionId ?? null);
  const [instructionBody, setInstructionBody] = useState("");
  const [instructionName, setInstructionName] = useState("");
  const [genDescription, setGenDescription] = useState("");
  const [generating, setGenerating] = useState(false);
  const [instructionModalPresetId, setInstructionModalPresetId] = useState<string | null>(null);
  const [instructionModalOriginalId, setInstructionModalOriginalId] = useState<string | null>(null);

  useEffect(() => {
    if (codeDefaultsReady) return;
    let active = true;
    const bootstrapGithub = async () => {
      try {
        const organizations = await api<GithubOrgsPayload>("/api/github/orgs");
        const org = organizations.lastOrg ?? organizations.orgs[0];
        if (!org) return;
        const repositories = await api<GithubReposPayload>(`/api/github/repos?org=${encodeURIComponent(org)}`);
        const repo = repositories.repos[0];
        if (!repo || !active) return;
        setForm((current) => ({ ...current, targetKind: "remote", org, repo, backend: "daytona" }));
      } catch {
        // No configured GitHub access: retain the usable local fallback.
      } finally {
        if (active) setCodeDefaultsReady(true);
      }
    };
    void bootstrapGithub();
    return () => {
      active = false;
    };
  }, [codeDefaultsReady]);

  // Seed "Base branch" with the selected repo's real default (not a hardcoded
  // "main"). Only replaces a branch the operator hasn't chosen: still empty, still
  // the placeholder "main", or still our own last auto-fill.
  useEffect(() => {
    if (form.targetKind !== "remote" || !form.repo) return;
    let active = true;
    const repoAtFetch = form.repo;
    api<{ repo: string; defaultBranch: string }>(`/api/github/default-branch?repo=${encodeURIComponent(form.repo)}`)
      .then((payload) => {
        if (!active || !payload.defaultBranch) return;
        setForm((current) => {
          if (current.repo !== repoAtFetch) return current;
          const untouched = !current.branch || current.branch === "main" || current.branch === autoBranchRef.current;
          if (!untouched) return current;
          autoBranchRef.current = payload.defaultBranch;
          return { ...current, branch: payload.defaultBranch };
        });
      })
      .catch(() => {
        // Repo default unavailable (no access / not installed): keep the current
        // value; the operator can still type the base branch by hand.
      });
    return () => { active = false; };
  }, [form.repo, form.targetKind]);

  useEffect(() => {
    if (codeDefaultsReady && !initial) saveCodeSettings(form);
  }, [
    codeDefaultsReady,
    form.targetKind,
    form.repoPath,
    form.org,
    form.repo,
    form.issue,
    form.branch,
    form.newBranch,
    form.branchName,
    form.publish,
    initial,
  ]);

  useEffect(() => {
    let alive = true;
    api<{ instructions: Instruction[] }>("/api/instructions")
      .then((r) => {
        if (!alive) return;
        setInstructions(r.instructions);
        // Hydrate the editor if a preset (or last run) had one selected.
        setSelectedInstructionId((current) => {
          const found = current ? r.instructions.find((i) => i.id === current) : undefined;
          if (found) {
            setInstructionBody(found.body);
            setInstructionName(found.name);
          }
          return found ? current : null;
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const selectInstruction = (id: string | null) => {
    if (!id) {
      setSelectedInstructionId(null);
      setInstructionBody("");
      setInstructionName("");
      return;
    }
    const found = instructions.find((i) => i.id === id);
    if (!found) return;
    setSelectedInstructionId(id);
    setInstructionBody(found.body);
    setInstructionName(found.name);
  };

  const openInstructionModal = (presetId: string, instructionId: string | null) => {
    setInstructionModalOriginalId(selectedInstructionId);
    selectInstruction(instructionId);
    setGenDescription("");
    setInstructionModalPresetId(presetId);
  };

  const closeInstructionModal = () => {
    setInstructionModalPresetId(null);
    selectInstruction(instructionModalOriginalId);
  };

  const generateInstruction = async () => {
    if (!genDescription.trim()) return;
    setGenerating(true);
    setError(null);
    try {
      const { body } = await api<{ body: string }>("/api/instructions/generate", {
        method: "POST",
        body: JSON.stringify({ description: genDescription }),
      });
      setInstructionBody(body);
      setSelectedInstructionId(null); // generated text diverges from any saved one
    } catch (err) {
      setError(String(err));
    } finally {
      setGenerating(false);
    }
  };

  // Persist the editor. With an id → update that instruction; without → create.
  const persistInstruction = async (id?: string) => {
    const name = instructionName.trim();
    if (!name || !instructionBody.trim()) return;
    try {
      const saved = await api<Instruction>("/api/instructions", {
        method: "POST",
        body: JSON.stringify({ ...(id ? { id } : {}), name, body: instructionBody }),
      });
      setInstructions((current) => [saved, ...current.filter((i) => i.id !== saved.id)]);
      setSelectedInstructionId(saved.id);
      setInstructionName(saved.name);
    } catch (err) {
      setError(String(err));
    }
  };

  const deleteInstruction = async () => {
    if (!selectedInstructionId) return;
    try {
      const { instructions: remaining } = await api<{ instructions: Instruction[] }>(
        `/api/instructions/${encodeURIComponent(selectedInstructionId)}`,
        { method: "DELETE" },
      );
      setInstructions(remaining);
      selectInstruction(null);
    } catch (err) {
      setError(String(err));
    }
  };

  const selectedInstruction = selectedInstructionId ? instructions.find((i) => i.id === selectedInstructionId) : undefined;
  const instructionDirty =
    !!selectedInstruction && (selectedInstruction.body !== instructionBody || selectedInstruction.name !== instructionName.trim());

  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [nativeBrowsing, setNativeBrowsing] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [codeSettingsOpen, setCodeSettingsOpen] = useState(false);

  const providerModels = options.providers.find((p) => p.id === form.provider)?.models ?? [form.model];
  const isRemote = form.targetKind === "remote";
  const branchTarget = form.newBranch ? "automatic branch" : form.branch;
  const codeLocation = isRemote
    ? (form.repo || "Choose a GitHub repository")
    : (form.repoPath.split("/").filter(Boolean).at(-1) || "Choose a local folder");
  const codeBranchSummary = form.newBranch
    ? `${form.branch || "main"} → automatic new branch`
    : form.branch || "Choose a branch";
  const runAction = runActionCopy(form);
  const backendOptions = isRemote ? options.backends.filter((backend) => backend !== "container") : options.backends;

  const patch = (next: Partial<LaunchForm>) => setForm((current) => ({ ...current, ...next }));

  const applyPreset = (preset: RobotPreset) => {
    patch({ provider: preset.provider, model: preset.model, backend: preset.backend, agent: preset.agent });
    setSkills([...preset.skills]);
    selectInstruction(preset.instructionId ?? null);
    setActivePresetId(preset.id);
    saveActiveRobotPresetId(preset.id);
  };

  // Manual edits from the settings popover diverge from whichever preset was active, so drop the highlight.
  const patchAgentSettings = (next: Partial<LaunchForm>) => {
    setActivePresetId(null);
    saveActiveRobotPresetId(null);
    patch(next);
  };

  const setSkillsManually: typeof setSkills = (updater) => {
    setActivePresetId(null);
    saveActiveRobotPresetId(null);
    setSkills(updater);
  };

  const saveCurrentAsPreset = (name: string) => {
    const preset: RobotPreset = {
      id: (crypto.randomUUID?.() ?? `preset-${Date.now()}`),
      name,
      provider: form.provider,
      model: form.model,
      backend: form.backend,
      agent: form.agent,
      skills: [...skills],
      ...(selectedInstructionId ? { instructionId: selectedInstructionId } : {}),
    };
    setPresets((current) => {
      const next = [...current, preset];
      saveRobotPresets(next);
      return next;
    });
    setActivePresetId(preset.id);
    saveActiveRobotPresetId(preset.id);
  };

  const removePreset = (id: string) => {
    setPresets((current) => {
      const next = current.filter((preset) => preset.id !== id);
      saveRobotPresets(next);
      return next;
    });
    if (activePresetId === id) {
      setActivePresetId(null);
      saveActiveRobotPresetId(null);
    }
  };

  const updatePreset = (updated: RobotPreset) => {
    setPresets((current) => {
      const next = current.map((preset) => (preset.id === updated.id ? updated : preset));
      saveRobotPresets(next);
      return next;
    });
    if (activePresetId === updated.id) {
      patch({ provider: updated.provider, model: updated.model, backend: updated.backend, agent: updated.agent });
      setSkills([...updated.skills]);
      selectInstruction(updated.instructionId ?? null);
    }
  };

  const assignInstructionToPreset = (instructionId: string | null) => {
    if (!instructionModalPresetId) return;
    if (instructionModalPresetId === CURRENT_ROBOT_PROMPT) {
      selectInstruction(instructionId);
      setInstructionModalPresetId(null);
      return;
    }
    const preset = presets.find((item) => item.id === instructionModalPresetId);
    if (!preset) return;
    const { instructionId: _drop, ...rest } = preset;
    updatePreset(instructionId ? { ...rest, instructionId } : rest);
    setInstructionModalPresetId(null);
  };

  const chooseTargetKind = (kind: "local" | "remote") => patch({ targetKind: kind });

  const submit = async () => {
    setLaunching(true);
    setError(null);
    try {
      await onLaunch(form, instructionBody.trim() || undefined);
    } catch (err) {
      setError(String(err));
    } finally {
      setLaunching(false);
    }
  };

  const chooseNativeFolder = async () => {
    setNativeBrowsing(true);
    setError(null);
    try {
      const response = await fetch(`${API_BASE}/api/local/choose-folder`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: form.repoPath }),
      });
      const body = (await response.json()) as NativeFolderPayload;
      if (!response.ok) {
        if (body.cancelled) return;
        throw new Error(body.error ?? `${response.status} ${response.statusText}`);
      }
      if (body.path) patch({ repoPath: body.path });
    } catch (err) {
      setError(String(err));
    } finally {
      setNativeBrowsing(false);
    }
  };

  return (
    <section className="launch-view">
      <header className="launch-head robot-head">
        <div className="robot-bar" role="group" aria-label="Agent presets">
          {presets.map((preset) => (
            <RobotTile
              key={preset.id}
              preset={preset}
              active={preset.id === activePresetId}
              options={options}
              instructions={instructions}
              onApply={() => applyPreset(preset)}
              onUpdate={updatePreset}
              onRemove={() => removePreset(preset.id)}
              onManageInstruction={openInstructionModal}
            />
          ))}
          <AgentSettingsTile
            form={form}
            patch={patchAgentSettings}
            skills={skills}
            setSkills={setSkillsManually}
            options={options}
            providerModels={providerModels}
            backendOptions={backendOptions}
            isMatchedPreset={activePresetId !== null}
            hasPresets={presets.length > 0}
            onSavePreset={saveCurrentAsPreset}
            instructions={instructions}
            instructionId={selectedInstructionId}
            onManageInstruction={() => openInstructionModal(CURRENT_ROBOT_PROMPT, selectedInstructionId)}
          />
        </div>
        <span className="draft-state">Browser draft</span>
      </header>

      {instructionModalPresetId && (
        <div className="modal-backdrop" role="presentation" onMouseDown={closeInstructionModal}>
          <section
            className="instruction-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="instruction-modal-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="instruction-modal-head">
              <div>
                <span className="modal-kicker">Robot prompt</span>
                <h2 id="instruction-modal-title">System prompt</h2>
                <p>Choose a saved prompt, write one directly, or generate a starting point.</p>
              </div>
              <button type="button" className="icon-button" aria-label="Close prompt editor" onClick={closeInstructionModal}><X size={16} /></button>
            </header>

            <InstructionSelect label="Saved prompt" value={selectedInstructionId} instructions={instructions} onChange={selectInstruction} />

            <label className="instruction-modal-field">
              <span>Prompt</span>
              <textarea
                value={instructionBody}
                onChange={(event) => setInstructionBody(event.target.value)}
                placeholder="Describe how this robot should behave…"
                autoFocus
              />
            </label>

            <div className="instruction-generate">
              <input
                value={genDescription}
                onChange={(event) => setGenDescription(event.target.value)}
                placeholder="Describe the prompt you want generated…"
                aria-label="Describe the instruction to generate"
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void generateInstruction();
                  }
                }}
              />
              <button type="button" className="instruction-gen-button" disabled={generating || !genDescription.trim()} onClick={() => void generateInstruction()}>
                <Sparkles size={14} /> {generating ? "Generating…" : "Generate"}
              </button>
            </div>

            <div className="instruction-save-row">
              <input
                value={instructionName}
                onChange={(event) => setInstructionName(event.target.value)}
                placeholder="Prompt name"
                aria-label="Prompt name"
              />
              {instructionDirty && (
                <button type="button" className="secondary-button" disabled={!instructionName.trim() || !instructionBody.trim()} onClick={() => void persistInstruction(selectedInstructionId ?? undefined)}>
                  <Check size={13} /> Save
                </button>
              )}
              <button type="button" className="secondary-button" disabled={!instructionName.trim() || !instructionBody.trim()} onClick={() => void persistInstruction()}>
                <Plus size={13} /> Save new
              </button>
              {selectedInstructionId && (
                <button type="button" className="icon-button instruction-delete" aria-label="Delete saved prompt" onClick={() => void deleteInstruction()}>
                  <Trash2 size={14} />
                </button>
              )}
            </div>

            <footer className="instruction-modal-foot">
              <button type="button" className="secondary-button" onClick={() => assignInstructionToPreset(null)}>No prompt</button>
              <span />
              <button type="button" className="secondary-button" onClick={closeInstructionModal}>Cancel</button>
              <button type="button" className="org-save" disabled={!selectedInstructionId} onClick={() => assignInstructionToPreset(selectedInstructionId)}>
                Use prompt
              </button>
            </footer>
          </section>
        </div>
      )}

      {codeSettingsOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setCodeSettingsOpen(false); }}>
          <section className="code-settings-modal" role="dialog" aria-modal="true" aria-labelledby="code-settings-title">
            <header className="instruction-modal-head">
              <div>
                <span className="modal-kicker">Run destination</span>
                <h2 id="code-settings-title">Code &amp; delivery</h2>
                <p>Choose the checkout, base branch, and how the finished work should be delivered.</p>
              </div>
              <button type="button" className="icon-button" aria-label="Close code settings" onClick={() => setCodeSettingsOpen(false)}><X size={16} /></button>
            </header>

            <section className="code-modal-section">
              <div className="config-block-head"><h3>Code</h3><p>Where the work should land.</p></div>
              <div className="target-kind-switch" role="tablist" aria-label="Target kind">
                <button role="tab" aria-selected={!isRemote} className={!isRemote ? "active" : ""} onClick={() => chooseTargetKind("local")}><FolderGit2 size={13} /> Local</button>
                <button role="tab" aria-selected={isRemote} className={isRemote ? "active" : ""} onClick={() => chooseTargetKind("remote")}><Github size={13} /> GitHub</button>
              </div>
              {isRemote ? (
                <>
                  <GithubTargetPicker org={form.org} repo={form.repo} onChange={patch} />
                  <div className="field-grid github-meta-fields">
                    <FieldInput label="Base branch" value={form.branch} onChange={(branch) => patch({ branch })} icon={<GitBranch size={14} />} placeholder="main" />
                    <FieldInput label="Issue (optional)" value={form.issue} onChange={(issue) => patch({ issue })} icon={<Link2 size={14} />} placeholder="123" />
                  </div>
                </>
              ) : (
                <div className="field-grid target-fields">
                  <div className="field-with-action">
                    <FieldInput label="Local checkout" value={form.repoPath} onChange={(repoPath) => patch({ repoPath })} icon={<Github size={14} />} placeholder="/Users/caleb/code/project" />
                    <div className="browse-split">
                      <button className="browse-button" disabled={nativeBrowsing} onClick={() => void chooseNativeFolder()}><FolderGit2 size={13} /> {nativeBrowsing ? "Choosing…" : "Browse"}</button>
                      <button className="browse-menu-button" aria-label="Recent local checkouts" onClick={() => setBrowseOpen(true)}><ChevronDown size={14} /></button>
                    </div>
                  </div>
                  <div className="field-with-action branch-field-with-action">
                    <FieldInput label="Base branch" value={form.branch} onChange={(branch) => patch({ branch })} icon={<GitBranch size={14} />} />
                    <button className="browse-menu-button branch-picker-button" aria-label="Recent and detected branches" onClick={() => setBranchOpen(true)}><ChevronDown size={14} /></button>
                  </div>
                </div>
              )}
            </section>

            <section className="code-modal-section">
              <div className="config-block-head"><h3>Delivery</h3><p>Branch &amp; PR for the work.</p></div>
              <label className="branch-toggle">
                <input type="checkbox" checked={form.newBranch} onChange={(event) => patch({ newBranch: event.target.checked })} />
                <span className="toggle-track"><i /></span>
                <span><strong>Create a new branch</strong><small>{form.newBranch ? "name generated when the run starts" : `work on ${form.branch}`}</small></span>
              </label>
              <label className="branch-toggle publish-toggle">
                <input type="checkbox" checked={form.publish} onChange={(event) => patch({ publish: event.target.checked })} />
                <span className="toggle-track"><i /></span>
                <span><strong>Open a draft PR when done</strong><small>{isRemote ? "pushes the branch from the sandbox, opens a draft PR" : "pushes the branch & opens a draft PR"}</small></span>
              </label>
            </section>

            <footer className="code-settings-foot">
              <span>{isRemote ? "GitHub" : "Local"} · {codeLocation} · {codeBranchSummary}</span>
              <button type="button" className="org-save" onClick={() => setCodeSettingsOpen(false)}>Done</button>
            </footer>
          </section>
        </div>
      )}

      <div className="launch-body">
        <div className="launch-main">
          <button type="button" className="code-context-button" onClick={() => setCodeSettingsOpen(true)}>
            <span className="code-context-icon">{isRemote ? <Github size={13} /> : <FolderGit2 size={13} />}</span>
            <span className="code-context-copy">
              <strong>{codeLocation}</strong>
              <small>{codeBranchSummary}</small>
            </span>
            <span className="code-context-edit">Code settings <ChevronRight size={12} /></span>
          </button>
          <section className="launch-section prompt-section">
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
              <span>{isRemote ? <Github size={13} /> : <FolderGit2 size={13} />} {isRemote ? (form.repo ? targetLabel({ kind: "remote", repo: form.repo, branch: branchTarget, ...(form.issue.trim() ? { issue: Number(form.issue) } : {}) }) : "owner/name") : (form.repoPath ? targetLabel({ kind: "local", repoPath: form.repoPath, branch: branchTarget }) : "local checkout")}</span>
              <span><Bot size={13} /> {providerLabel(form.provider)} · {form.model}</span>
              <span><Cloud size={13} /> {backendLabel(form.backend)}</span>
            </div>
            <button className="launch-button" disabled={!form.prompt.trim() || (isRemote ? !form.repo.trim() : !form.repoPath.trim()) || launching} onClick={submit}>
              {launching ? runAction.busy : runAction.idle} <span>⌘↵</span><ArrowUpRight size={14} />
            </button>
          </div>
        </div>

        <aside className="config-panel">
          <section className="config-block">
            <div className="config-block-head"><h3>QA review</h3><p>Screenshot the feature after the run.</p></div>
            <label className="branch-toggle publish-toggle">
              <input type="checkbox" checked={form.qaReview} onChange={(event) => patch({ qaReview: event.target.checked })} />
              <span className="toggle-track"><i /></span>
              <span><strong>Run QA review</strong><small>a QA agent screenshots the feature and posts one image</small></span>
            </label>
          </section>

          <section className="config-block issues-panel">
            {isRemote && form.repo ? (
              <IssuesPanel
                repo={form.repo}
                onUse={(issue) => patch({ prompt: issueAsPrompt(issue), issue: String(issue.number), title: issue.title.slice(0, 80) || form.title })}
              />
            ) : (
              <>
                <div className="issues-head"><div><span>Open issues</span></div></div>
                <p>Pick a GitHub repository to list its open issues.</p>
              </>
            )}
          </section>
        </aside>
      </div>
      {browseOpen && (
        <LocalCheckoutModal
          initialPath={form.repoPath}
          onClose={() => setBrowseOpen(false)}
          onChoose={(repoPath) => patch({ repoPath })}
        />
      )}
      {branchOpen && (
        <BranchPickerModal
          repoPath={form.repoPath}
          selectedBranch={form.branch}
          onClose={() => setBranchOpen(false)}
          onChoose={(branch) => patch({ branch })}
        />
      )}
    </section>
  );
}

function sessionMarkdown(session: AgentSession, index: number, entries: TimelineEntry[]): string {
  const promptText = session.prompt?.task || session.prompt?.assembled || "(prompt not persisted)";
  const target = session.settings.target;
  const lines: string[] = [
    `## Agent session ${String(index + 1).padStart(2, "0")}`,
    "",
    `**Prompt:** ${promptText}`,
    "",
    "**Settings**",
    `- Provider: ${providerLabel(session.settings.provider)}`,
    `- Model: ${session.settings.model}`,
    `- Backend: ${backendLabel(session.settings.backend)}`,
    `- Agent: ${session.settings.agent}`,
    `- Target: ${targetLabel(target)} (${target.kind})`,
    `- Branch: ${target.branch}${target.newBranch ? ` → ${target.newBranch}` : ""}`,
    `- Status: ${session.status}`,
    `- Session ID: \`${session.id}\``,
  ];
  if (session.startedAt) lines.push(`- Started: ${session.startedAt}`);
  if (session.finishedAt) lines.push(`- Finished: ${session.finishedAt}`);
  if (session.error) lines.push("", `**Error:** ${session.error}`);
  if (entries.length) {
    lines.push("", `### Orchestration timeline (${entries.length} entries)`, "", "| Δt | source | level | message |", "| --- | --- | --- | --- |");
    for (const e of entries) {
      lines.push(`| ${e.rel} | ${e.source} | ${e.level} | ${e.message.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`);
    }
    lines.push("", "<details><summary>Raw entries (JSON)</summary>", "", "```json", JSON.stringify(entries, null, 2), "```", "", "</details>");
  }
  return lines.join("\n") + "\n";
}

function SessionCard({ session, index, entries }: { session: AgentSession; index: number; entries: TimelineEntry[] }) {
  const [showMore, setShowMore] = useState(index === 0);
  const [copied, setCopied] = useState(false);
  const promptText = session.prompt?.task || session.prompt?.assembled || "Session accepted; waiting for the runner to persist the prompt.";

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(sessionMarkdown(session, index, entries));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // clipboard unavailable (insecure context); leave state unchanged
    }
  };

  return (
    <div className="session-card" id={session.id}>
      <button className="session-copy" onClick={() => void copy()} title="Copy session + orchestration as markdown" aria-label="Copy session as markdown">
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
      <div className="session-heading">
        <span className="session-number">{String(index + 1).padStart(2, "0")}</span>
        <p className="session-prompt">{showMore ? promptText : `${promptText.slice(0, 180)}${promptText.length > 180 ? "…" : ""}`}</p>
      </div>
      {session.error && <p className="prompt-more">Error: {session.error}</p>}
      <div className="session-footer">
        <span><GitBranch size={12} /> {targetBranch(session.settings.target)}</span>
        <span className="session-runtime"><Bot size={12} /> {providerLabel(session.settings.provider)} <span>·</span> {session.settings.model} <span>·</span> {backendLabel(session.settings.backend)}</span>
        <span><Link2 size={12} /> {session.status}</span>
        <button onClick={() => setShowMore((v) => !v)}>{showMore ? "Collapse prompt" : "Full prompt"} <ChevronDown size={11} /></button>
      </div>
    </div>
  );
}

function entryKind(entry: TimelineEntry): string {
  return typeof entry.data?.kind === "string" ? entry.data.kind : "";
}

function isToolEntry(entry: TimelineEntry): boolean {
  const kind = entryKind(entry);
  return kind.includes("tool") || entry.message.startsWith("tool");
}

function toolName(entry: TimelineEntry): string {
  const tool = entry.data?.tool;
  if (typeof tool === "string" && tool.trim()) return tool;
  return entry.message.replace(/^[→←]\s*/, "").trim() || "tool";
}

function toolDetail(entry: TimelineEntry): string {
  const kind = entryKind(entry);
  if (kind === "tool-call" || kind.includes("call")) {
    const args = entry.data?.arguments ?? entry.data?.input;
    if (args === undefined) return entry.message;
    if (typeof args === "string") return args;
    return JSON.stringify(args, null, 2);
  }
  const text = entry.data?.text ?? entry.data?.output ?? entry.data?.result;
  if (typeof text === "string" && text.trim()) return text;
  if (text !== undefined) return JSON.stringify(text, null, 2);
  return entry.message;
}

function ToolEntryView({ entry }: { entry: TimelineEntry }) {
  const [open, setOpen] = useState(false);
  const kind = entryKind(entry);
  const isResult = kind.includes("result") || entry.message.startsWith("←");
  const detail = toolDetail(entry);

  return (
    <div className={`tool-call compact-tool ${open ? "open" : "closed"}`}>
      <button className="tool-title tool-disclosure" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="tool-icon"><Search size={13} /></span>
        <span><strong>{toolName(entry)}</strong><small>{isResult ? "tool result" : "tool call"}</small></span>
        <span className="tool-time">{entry.rel}</span>
        <ChevronDown size={13} />
      </button>
      {open && <pre className="tool-detail">{detail}</pre>}
    </div>
  );
}

function WorkingGroup({ entries }: { entries: TimelineEntry[] }) {
  const [open, setOpen] = useState(false);
  const calls = entries.filter((entry) => entryKind(entry).includes("call")).length;
  const results = entries.filter((entry) => entryKind(entry).includes("result")).length;
  const tools = [...new Set(entries.map(toolName))].slice(0, 4).join(", ");

  return (
    <div className={`working-group ${open ? "open" : "closed"}`}>
      <button className="working-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <ChevronDown size={13} />
        <span><strong>Working</strong><small>{calls} calls · {results} results{tools ? ` · ${tools}` : ""}</small></span>
        <em>{entries[0]?.rel}</em>
      </button>
      {open && (
        <div className="working-items">
          {entries.map((entry) => <ToolEntryView entry={entry} key={`${entry.ts}-${entry.message}-${entryKind(entry)}`} />)}
        </div>
      )}
    </div>
  );
}

function LogEntryView({ entry }: { entry: TimelineEntry }) {
  const [thinkingOpen, setThinkingOpen] = useState(true);

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

  const kind = entryKind(entry);
  if (isToolEntry(entry)) return <ToolEntryView entry={entry} />;

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
      <div className={`thinking ${thinkingOpen ? "open" : "closed"}`}>
        <button aria-expanded={thinkingOpen} onClick={() => setThinkingOpen((open) => !open)}>
          <ChevronDown size={13} /> Thinking · {entry.rel}
        </button>
        {thinkingOpen && <p>{entry.message}</p>}
      </div>
    );
  }

  return <p className="agent-copy">{entry.message}</p>;
}

function TimelineForSession({ entries, prompt, label = "Agent trace" }: { entries: TimelineEntry[]; prompt?: string; label?: string }) {
  const [infraOpen, setInfraOpen] = useState(false);
  const [traceCollapsed, setTraceCollapsed] = useState(false);
  const infra = entries.filter((entry) => entry.source === "orchestrator" || entry.source === "backend" || entry.source === "workflow");
  const main = entries.filter((entry) => entry.source === "agent" || entry.source === "workload");
  const firstInfra = infra.slice(0, 2);
  const hiddenInfra = infra.slice(2);
  const mainGroups: Array<TimelineEntry | TimelineEntry[]> = [];
  for (const entry of main) {
    if (isToolEntry(entry)) {
      const last = mainGroups.at(-1);
      if (Array.isArray(last)) last.push(entry);
      else mainGroups.push([entry]);
    } else {
      mainGroups.push(entry);
    }
  }

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
          <button className="turn-label turn-toggle" onClick={() => setTraceCollapsed((v) => !v)} aria-expanded={!traceCollapsed}>
            <ChevronRight size={12} className={traceCollapsed ? "" : "rotated"} />
            <strong>{label}</strong>
            <span>{main.length ? formatClock(main[0]?.ts) : "waiting"}</span>
            {main.length > 0 && <span className="turn-collapsed-hint">{mainGroups.length} step{mainGroups.length === 1 ? "" : "s"}</span>}
            {prompt && <span className="turn-collapsed-prompt">{prompt.trim().split("\n")[0]}</span>}
          </button>
          {traceCollapsed ? null : mainGroups.length ? mainGroups.map((item, index) => (
            Array.isArray(item)
              ? <WorkingGroup entries={item} key={`working-${index}-${item[0]?.ts ?? ""}`} />
              : <LogEntryView entry={item} key={`${item.ts}-${item.message}`} />
          )) : (
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
  onFork,
}: {
  rendered: RenderedConversation;
  onContinue: (task: string, latest: AgentSession) => Promise<void>;
  onRefresh: () => void;
  onFork: () => void;
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

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "auto") => {
    const el = viewportRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
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
    if (following) scrollToBottom();
  }, [following, rendered.timeline.entries.length, scrollToBottom]);

  const jumpToLatest = () => {
    setFollowing(true);
    scrollToBottom("smooth");
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
          <button className="secondary-button" onClick={onFork} title="Start a new run with these settings"><GitBranch size={14} /> Fork</button>
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
              <SessionCard session={session} index={index} entries={entriesBySession.get(session.id) ?? []} />
              <TimelineForSession entries={entriesBySession.get(session.id) ?? []} prompt={session.prompt?.task || session.prompt?.assembled || ""} label={providerLabel(session.settings.provider)} />
              {session.artifacts?.length ? <SessionArtifacts conversationId={rendered.conversation.id} sessionId={session.id} artifacts={session.artifacts} /> : null}
              {(() => { const pub = publishEventFor(rendered.events, session.id); return pub ? <PublishCard event={pub} target={rendered.conversation.target} /> : null; })()}
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
  const [draft, setDraft] = useState<Partial<LaunchForm> | undefined>(undefined);
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
    setDraft(undefined);
    setSelectedId(null);
    setRendered(null);
    setView("new");
    window.history.pushState(null, "", "/new");
  };

  const forkRun = () => {
    if (!rendered) return;
    const latest = rendered.sessions.at(-1);
    const target = rendered.conversation.target;
    setDraft({
      title: rendered.conversation.title,
      targetKind: target.kind,
      repoPath: target.kind === "local" ? target.repoPath : "",
      org: target.kind === "remote" ? target.repo.split("/")[0] ?? "" : "",
      repo: target.kind === "remote" ? target.repo : "",
      issue: target.kind === "remote" && target.issue ? String(target.issue) : "",
      branch: target.branch,
      newBranch: false,
      provider: (latest?.settings.provider as ProviderKind) ?? "pi",
      model: latest?.settings.model ?? options.providers[0]?.models[0] ?? "anthropic/claude-haiku-4.5",
      backend: (latest?.settings.backend as BackendKind) ?? "local",
      agent: latest?.settings.agent ?? "generic",
      prompt: "",
    });
    setSelectedId(null);
    setRendered(null);
    setView("new");
    window.history.pushState(null, "", "/new");
  };

  const launch = async (form: LaunchForm, persona?: string) => {
    const issue = form.issue.trim();
    const target: Target = form.targetKind === "remote"
      ? {
          kind: "remote",
          repo: form.repo.trim(),
          branch: form.branch,
          ...(/^\d+$/.test(issue) ? { issue: Number(issue) } : {}),
        }
      : { kind: "local", repoPath: form.repoPath, branch: form.branch };
    const conv = await api<Conversation>("/api/conversations", {
      method: "POST",
      body: JSON.stringify({
        title: form.title || form.prompt.split("\n")[0] || "Agent run",
        target,
        createNewBranch: form.newBranch,
        branchPrompt: form.prompt,
      }),
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
        ...(persona ? { persona } : {}),
        publish: form.publish,
        qaReview: form.qaReview,
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
          <button className={`new-run ${view === "new" ? "active" : ""}`} onClick={newRun}><Play size={13} fill="currentColor" /> New run</button>
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
        </aside>

        {view === "new" ? (
          <NewRunView key={draft ? "fork" : "new"} options={options} onLaunch={launch} initial={draft} />
        ) : rendered ? (
          <ConversationView rendered={rendered} onContinue={continueConversation} onRefresh={() => { if (selectedId) void loadConversation(selectedId); }} onFork={forkRun} />
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
