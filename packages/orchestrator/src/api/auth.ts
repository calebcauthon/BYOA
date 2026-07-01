/**
 * Single-operator auth: a PIN gate in front of every /api route.
 *
 * The operator enters a PIN; if it matches AUTH_PIN we hand back an HMAC-signed
 * session cookie (signed with AUTH_SECRET). Every subsequent request is gated by
 * verifying that signature and its expiry — no per-route wiring, just one check
 * in route(). There is exactly one identity, so there is no user table, no
 * password hashing scheme, just a shared PIN and a signed cookie.
 *
 * Config (env):
 *   AUTH_PIN     the PIN. If unset, auth is DISABLED (open) — set it in prod.
 *   AUTH_SECRET  key used to sign session cookies. If unset, an ephemeral random
 *                key is generated (sessions won't survive a restart).
 *   AUTH_SESSION_TTL_HOURS  session lifetime, default 720 (30 days).
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

const COOKIE_NAME = "automations_session";
const PIN = process.env.AUTH_PIN?.trim() || "";
const SECRET = process.env.AUTH_SECRET?.trim() || randomBytes(32).toString("hex");
const SECRET_IS_EPHEMERAL = !process.env.AUTH_SECRET?.trim();
const TTL_MS = Math.max(1, Number(process.env.AUTH_SESSION_TTL_HOURS ?? 720)) * 60 * 60 * 1000;

/** Auth is only enforced when a PIN is configured. */
export function authEnabled(): boolean {
  return PIN.length > 0;
}

/** Loud, one-line status at boot so an open deployment is never a surprise. */
export function logAuthStatus(write: (line: string) => void): void {
  if (!authEnabled()) {
    write("⚠ auth DISABLED — set AUTH_PIN to require a login (all /api routes are open)\n");
    return;
  }
  write("auth enabled — PIN required" + (SECRET_IS_EPHEMERAL ? " (⚠ AUTH_SECRET unset: sessions reset on restart)\n" : "\n"));
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function sign(payload: string): string {
  return createHmac("sha256", SECRET).update(payload).digest("base64url");
}

/** A fresh session token: `<payload>.<hmac>`, payload carries the expiry. */
export function signSession(): string {
  const payload = b64url(JSON.stringify({ exp: Date.now() + TTL_MS }));
  return `${payload}.${sign(payload)}`;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function verifySession(token: string | undefined): boolean {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot < 0) return false;
  const payload = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!safeEqual(mac, sign(payload))) return false;
  try {
    const { exp } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: number };
    return typeof exp === "number" && Date.now() < exp;
  } catch {
    return false;
  }
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/** True when the request may proceed: either auth is off, or the cookie is valid. */
export function isAuthenticated(req: IncomingMessage): boolean {
  if (!authEnabled()) return true;
  return verifySession(parseCookies(req)[COOKIE_NAME]);
}

/** Timing-safe PIN comparison. */
export function checkPin(input: unknown): boolean {
  return typeof input === "string" && input.length > 0 && safeEqual(input, PIN);
}

function isHttps(req: IncomingMessage): boolean {
  const proto = req.headers["x-forwarded-proto"];
  return (Array.isArray(proto) ? proto[0] : proto) === "https";
}

/** Set-Cookie for a new session. Secure is added behind HTTPS (Railway proxy). */
export function setSessionCookie(res: ServerResponse, req: IncomingMessage): void {
  const attrs = [
    `${COOKIE_NAME}=${signSession()}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${Math.floor(TTL_MS / 1000)}`,
  ];
  if (isHttps(req)) attrs.push("Secure");
  res.setHeader("Set-Cookie", attrs.join("; "));
}

/** Set-Cookie that expires the session immediately. */
export function clearSessionCookie(res: ServerResponse): void {
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}
