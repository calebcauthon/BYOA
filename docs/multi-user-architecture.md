# Multi-User Architecture — Isolation & API

> How the platform becomes multi-user **without** losing the ability to run it
> locally as a single operator, and how everything is reachable over an API.
> This is an architecture decision record; the phased build lives in
> [`saas-plan.md`](saas-plan.md).

## Locked decisions

1. **BYOK billing** — users bring their own LLM key; we sell a subscription. No
   token metering. (See [`saas-plan.md`](saas-plan.md).)
2. **One GitHub App** we own; per-installation, repo-scoped, short-lived tokens.
3. **Pooled Daytona** under our org; per-session isolation already exists.
4. **Postgres** for accounts/billing; conversation logs stay on a volume.
5. **Tenancy is an isolated boundary layer, not baked into the core.** The
   orchestrator/runner have zero knowledge of users. (This doc.)
6. **The HTTP `/api` is a first-class product surface.** The console is just its
   first client; programmatic access is the same API with a different auth
   adapter. (This doc.)
7. **Login is SSO-only (GitHub + Google), OAuth hand-rolled in `packages/tenancy`.**
   No passwords, no email provider at launch — drops the reset/verify machinery.
   Login is just a `resolvePrincipal` account-creation path; GitHub's user-to-server
   flow can do login *and* repo access in one. (Decided 2026-06-30.)

## The governing principle: identity is a *port*, not a feature

Everything that makes this "multi-user" — accounts, Postgres, Stripe, email, the
GitHub App, the secret vault — sits **in front of** the core as a swappable
adapter behind one interface. The core depends on the *interface*, never on the
tenancy package. Dependency points inward only:

```
        depends on ───────────────►
  tenancy  ─────►  orchestrator  ─────►  runner  ─────►  core
 (adapter)        (owns /api,            (standalone      (pure
                   depends on Identity    session)         primitives)
                   PORT, ships a
                   Local default)
```

Because the arrow never reverses, deleting/disabling the tenancy package leaves a
fully working single-operator app. That is the "run it locally easily" guarantee,
enforced by module boundaries — not discipline.

### The port

The orchestrator defines (and depends on) one small interface. Two adapters
implement it.

```ts
interface Principal { id: string }               // opaque scope key

interface Identity {
  // Who is this request? Local: always the singleton. Hosted: verify
  // session cookie OR Bearer API key → a user. Null → 401.
  resolvePrincipal(req): Promise<Principal | null>;

  // The credentials a session needs, for THIS principal. Local: host env +
  // `gh auth token`. Hosted: decrypt BYOK key from the vault + mint a GitHub
  // App installation token. This is the Phase-0 credential seam.
  resolveCredentials(p: Principal): Promise<{ githubToken?: string; llmKey?: string }>;

  // Optional: routes this adapter wants mounted (signup/login/billing/keys).
  // Local adapter returns none. Hosted adapter returns the account API.
  routes?(): RouteTable;
}
```

- The orchestrator's `route()` calls `resolvePrincipal` once, then scopes all
  conversation reads/writes by `principal.id` and passes resolved credentials
  into `runSession`. It has no idea whether the principal came from a cookie, an
  API key, or a hardcoded local singleton.
- `packages/core` and `packages/runner` never even see `Identity` — the runner
  already takes credentials via session settings (Phase 0). Only the orchestrator
  holds the port.

## Two run modes, one codebase

Selected by config at boot; the difference is *which adapter is wired*, nothing
else.

| | **Local mode** (`make dev`) | **Hosted mode** (the site) |
|---|---|---|
| Identity adapter | `LocalIdentity` — one built-in principal | `TenancyIdentity` (Postgres) |
| Auth | none, or the existing shared PIN | email+password session **or** API key |
| Credentials | host env (`OPENROUTER_API_KEY`) + `gh auth token` | BYOK vault + GitHub App mint |
| Datastore | filesystem only (as today) | Postgres (accounts) + volume (logs) |
| Stripe / email | absent | present |
| Extra `/api` routes | none | signup/login/reset/billing/keys |
| Deps loaded | tenancy package **not imported** | tenancy package imported |

Local mode requires **no Postgres, no Stripe, no email, no GitHub App** — those
are all inside the tenancy package, which local mode never loads. `make dev` stays
exactly as simple as it is today.

## The API is the same `/api`, with auth as an adapter concern

The console already speaks to the orchestrator over plain REST-ish HTTP
(`/api/conversations`, `/api/conversations/:id/sessions`, …). So "give people an
API" is mostly *don't build a second one*:

- **One surface.** Programmatic clients hit the exact same routes the console
  does. The console has no privileged backdoor.
- **API keys are a third identity adapter path**, not a parallel API.
  `resolvePrincipal` accepts either a session cookie (browser) **or**
  `Authorization: Bearer <key>` (programmatic) and normalizes both to a
  `Principal`. Keys are per-user, stored **hashed** (`api_keys`: user_id,
  key_hash, prefix, last_used_at, created_at), shown once at creation.
- **Local mode API auth** is a static token from env (or open) — same routes,
  trivially scriptable.
- **Stable + documented.** Treat `/api` as a versioned contract; publish an
  OpenAPI spec so the API is a real product, not an accident of the console.

Net: the console, `curl`, and any SDK are peer clients of one authenticated API.

## Module layout

```
packages/core          primitives (pure) — unchanged
packages/runner        standalone session; takes creds via settings (Phase 0)
packages/orchestrator  owns Conversations + /api; depends on the Identity PORT;
                       ships LocalIdentity as the default adapter
packages/tenancy       NEW. Postgres, users, auth flows, Stripe, email, GitHub
                       App token minting, encrypted BYOK vault, API-key store.
                       Implements Identity; contributes account routes.
apps/console           an API client (cookie auth in the browser)
```

Entry points compose the app:
- **local** (`orchestrator/src/main.ts`): wires `LocalIdentity`. No tenancy import.
- **hosted** (a `apps/hosted` or `packages/tenancy` entry): wires
  `TenancyIdentity`, mounts its account routes, then serves the same orchestrator
  `/api` behind it.

Single process, config-gated — best for local simplicity and Railway's
single-service deploy. The port boundary keeps the option to split tenancy into
its own service later without touching the core.

## Why this shape

- **Local-first is structural.** You can't accidentally couple the core to users
  because the core can't import the package that knows about them.
- **Auth complexity is contained.** Cookies, API keys, Stripe, GitHub App JWTs —
  all live behind `resolvePrincipal`/`resolveCredentials`. The 200 lines of route
  handlers stay auth-agnostic.
- **The API comes for free.** Making auth an adapter means programmatic access is
  a new adapter path, not a new API.

## Implications for the phased plan

The Phase-0 "credential seam" in [`saas-plan.md`](saas-plan.md) **is** the
`Identity` port. Reframed:

- **Phase 0** now also introduces the `Identity` interface + `LocalIdentity`
  adapter (behavior-identical to today), and moves the orchestrator to call it.
- **Phases 1/3/4/5** all land inside `packages/tenancy` as the `TenancyIdentity`
  adapter — the core stops changing after Phase 0/2.
- **API keys** slot into Phase 1 (`api_keys` table + Bearer path in
  `resolvePrincipal`).
