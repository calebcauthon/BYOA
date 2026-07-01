/**
 * Login gate wrapped around the whole console. On mount it asks the orchestrator
 * whether a session exists (GET /api/auth/session). While logged out it renders
 * the PIN screen instead of the app; a 401 from any later request (dispatched as
 * an "auth:unauthorized" window event by the shared api() helper) drops us back
 * here. When auth is disabled server-side, the gate is transparent.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Lock } from "lucide-react";

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, "") ?? "";

type Status = "checking" | "in" | "out";

interface SessionInfo {
  authenticated: boolean;
  required: boolean;
}

export function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("checking");

  const check = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/auth/session`, { cache: "no-store", credentials: "same-origin" });
      const info = (await res.json()) as SessionInfo;
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
  if (status === "out") return <LoginScreen onSuccess={() => setStatus("in")} />;
  return <>{children}</>;
}

function LoginScreen({ onSuccess }: { onSuccess: () => void }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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
