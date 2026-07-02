/**
 * Login gate wrapped around the whole console. On mount it asks the orchestrator
 * whether a session exists (GET /api/auth/session). While logged out it renders
 * the PIN screen instead of the app; a 401 from any later request (dispatched as
 * an "auth:unauthorized" window event by the shared api() helper) drops us back
 * here. When auth is disabled server-side, the gate is transparent.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Github, KeyRound, Lock, LogOut, Settings, X } from "lucide-react";

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, "") ?? "";

type Status = "checking" | "in" | "out";

interface SessionInfo {
  authenticated: boolean;
  required: boolean;
  mode?: "local" | "hosted";
  user?: { id: string; email?: string; name?: string | null; avatarUrl?: string | null };
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("checking");
  const [session, setSession] = useState<SessionInfo | null>(null);

  const check = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/auth/session`, { cache: "no-store", credentials: "same-origin" });
      const info = (await res.json()) as SessionInfo;
      setSession(info);
      setStatus(info.authenticated ? "in" : "out");
    } catch {
      // Can't reach the server — treat as logged out so the operator sees a
      // login screen rather than a blank app that silently fails every call.
      setStatus("out");
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  useEffect(() => {
    const onUnauthorized = () => setStatus("out");
    window.addEventListener("auth:unauthorized", onUnauthorized);
    return () => window.removeEventListener("auth:unauthorized", onUnauthorized);
  }, []);

  if (status === "checking") {
    return (
      <div className="auth-screen">
        <div className="auth-card auth-card-quiet">Checking session…</div>
      </div>
    );
  }
  if (status === "out") return <LoginScreen mode={session?.mode} onSuccess={() => void check()} />;
  return (
    <>
      {children}
      {session?.mode === "hosted" ? <AccountControl user={session.user} onLogout={() => setStatus("out")} /> : null}
    </>
  );
}

function LoginScreen({ mode, onSuccess }: { mode: "local" | "hosted" | undefined; onSuccess: () => void }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  if (mode === "hosted") {
    const authError = new URLSearchParams(window.location.search).get("auth_error");
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <div className="auth-icon"><Lock size={20} /></div>
          <strong>Sign in</strong>
          <p>Use your GitHub or Google account.</p>
          {authError ? <span className="auth-error">{authError}</span> : null}
          <a className="auth-submit auth-sso" href={`${API_BASE}/api/auth/github`}><Github size={17} /> Continue with GitHub</a>
          <a className="auth-submit auth-sso auth-google" href={`${API_BASE}/api/auth/google`}>
            <span className="google-mark">G</span> Continue with Google
          </a>
        </div>
      </div>
    );
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !pin) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ pin }),
      });
      if (res.ok) {
        setPin("");
        onSuccess();
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "Incorrect PIN");
      setPin("");
      inputRef.current?.focus();
    } catch {
      setError("Could not reach the server");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={submit}>
        <div className="auth-icon">
          <Lock size={20} />
        </div>
        <strong>Operator console</strong>
        <p>Enter your PIN to continue.</p>
        <input
          ref={inputRef}
          className="auth-pin"
          type="password"
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="••••"
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          disabled={busy}
          aria-label="PIN"
        />
        {error ? <span className="auth-error">{error}</span> : null}
        <button type="submit" className="auth-submit" disabled={busy || !pin}>
          {busy ? "Checking…" : "Unlock"}
        </button>
      </form>
    </div>
  );
}

interface ApiKeyRecord {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
}

function AccountControl({ user, onLogout }: { user?: SessionInfo["user"]; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const [keys, setKeys] = useState<ApiKeyRecord[]>([]);
  const [created, setCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch(`${API_BASE}/api/account/api-keys`, { credentials: "same-origin" });
    if (!response.ok) throw new Error("Could not load API keys");
    const body = (await response.json()) as { keys: ApiKeyRecord[] };
    setKeys(body.keys);
  }, []);

  useEffect(() => {
    if (open) void load().catch((err) => setError(String(err)));
  }, [open, load]);

  const create = async () => {
    setError(null);
    const response = await fetch(`${API_BASE}/api/account/api-keys`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Console API key" }),
    });
    const body = (await response.json()) as { key?: string; error?: string };
    if (!response.ok || !body.key) return setError(body.error ?? "Could not create API key");
    setCreated(body.key);
    await load();
  };

  const revoke = async (id: string) => {
    await fetch(`${API_BASE}/api/account/api-keys/${encodeURIComponent(id)}`, {
      method: "DELETE",
      credentials: "same-origin",
    });
    await load();
  };

  const logout = async () => {
    await fetch(`${API_BASE}/api/auth/logout`, { method: "POST", credentials: "same-origin" });
    onLogout();
  };

  return (
    <>
      <button className="account-trigger" onClick={() => setOpen(true)} aria-label="Account settings"><Settings size={17} /></button>
      {open ? (
        <div className="account-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}>
          <section className="account-panel">
            <button className="account-close" onClick={() => setOpen(false)}><X size={18} /></button>
            <h2>Account</h2>
            <p className="account-email">{user?.name || user?.email}<br /><small>{user?.email}</small></p>
            <div className="account-heading"><KeyRound size={16} /><strong>API keys</strong></div>
            <p className="account-help">Use as <code>Authorization: Bearer …</code>. New keys are shown once.</p>
            {created ? <div className="account-secret"><code>{created}</code><button onClick={() => void navigator.clipboard.writeText(created)}>Copy</button></div> : null}
            {error ? <span className="auth-error">{error}</span> : null}
            <button className="auth-submit" onClick={() => void create()}>Create API key</button>
            <div className="account-keys">
              {keys.map((item) => (
                <div className="account-key" key={item.id}>
                  <span><strong>{item.name}</strong><small>{item.prefix}…</small></span>
                  <button onClick={() => void revoke(item.id)}>Revoke</button>
                </div>
              ))}
            </div>
            <button className="account-logout" onClick={() => void logout()}><LogOut size={16} /> Sign out</button>
          </section>
        </div>
      ) : null}
    </>
  );
}
