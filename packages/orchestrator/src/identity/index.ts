/**
 * The Identity PORT — the boundary that makes the app multi-user WITHOUT the core
 * knowing what a user is (docs/multi-user-architecture.md).
 *
 * The orchestrator depends only on this interface. Two adapters implement it:
 *   • LocalIdentity   — one built-in principal, credentials from host env/CLI.
 *                       This is today's single-operator behavior. (this package)
 *   • TenancyIdentity — Postgres accounts, BYOK vault, GitHub App tokens.
 *                       Lives in packages/tenancy, added in later phases.
 *
 * The dependency arrow never reverses: core/runner never import this, and this
 * never imports the tenancy package. Deleting tenancy leaves a working local app.
 */
import type { IncomingMessage } from "node:http";
import type { Credentials } from "@automations/core";

/** WHO a request is acting as. Opaque `id` doubles as the data-scoping key
 *  (Phase 2): "local" for the single operator, a userId in hosted mode. */
export interface Principal {
  id: string;
}

export interface Identity {
  readonly kind: string;
  /**
   * Resolve the request's principal, or null if it isn't authenticated. Local:
   * the singleton once the PIN gate passes. Hosted: verify a session cookie OR a
   * Bearer API key → the user.
   */
  resolvePrincipal(req: IncomingMessage): Promise<Principal | null>;
  /**
   * The secrets a session needs, for THIS principal — the one seam every
   * credential flows through. Local: host env + `gh auth token`. Hosted: decrypt
   * the BYOK key + mint a GitHub App installation token.
   */
  resolveCredentials(principal: Principal): Promise<Credentials>;
  /** one-line boot status, so the active identity mode is never a surprise */
  logStatus(write: (line: string) => void): void;
}

import { LocalIdentity } from "./local.ts";
import { HostedIdentity } from "./hosted.ts";

/**
 * Pick the identity adapter for this deployment. Local by default; a hosted
 * adapter (packages/tenancy) is selected here once it exists — the only place the
 * mode is chosen, so the rest of the orchestrator stays adapter-agnostic.
 */
export function createIdentity(): Identity {
  if (process.env.IDENTITY_MODE === "hosted") return new HostedIdentity();
  return new LocalIdentity();
}

export { HostedIdentity } from "./hosted.ts";
