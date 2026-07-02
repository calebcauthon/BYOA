# Going Multi-User — SaaS Launch Plan

> How we turn the single-operator console into a site people can sign up for.
> This is a requirements + phasing doc, not a description of current code.

## Decisions locked (2026-06-30)

1. **Billing = BYOK.** Users bring their own OpenRouter/Anthropic key. We charge a
   flat / per-seat subscription for the platform + GitHub App + sandboxes. **No
   token metering, no LLM cost on us.** (Sandbox-minute metering optional, later.)
2. **GitHub = one GitHub App we own.** Users *install* it and grant per-repo
   access. Per-installation, short-lived, repo-scoped tokens replace the host
   `gh auth token`.
3. **Sandboxes = pooled under our Daytona org.** Per-session isolation already
   exists (fresh sandbox per run, disposed after). We cap concurrency + optionally
   meter minutes. No per-user Daytona provisioning.
4. **Datastore = Postgres for accounts/billing** (Railway add-on). Conversation
   dirs + logs stay on a mounted volume.

## The core insight

Every credential today is **ambient** — read from host env or the host `gh` CLI:

| Credential | Read from (today) | Location |
|---|---|---|
| GitHub identity | `gh auth token` (host CLI) | `github/liaison.ts:86`, `runner/src/backends/daytona.ts:54` |
| LLM key | `process.env.OPENROUTER_API_KEY` | `runner/src/providers/pi.ts:37` |
| Daytona key | `process.env.DAYTONA_API_KEY` | `runner/src/backends/daytona.ts:154` |
| Operator identity | one shared `AUTH_PIN` | `api/auth.ts` |

**The whole project is: give every request a `userId`, load that user's
credentials, and pass them explicitly into the session/backend — instead of
reading host globals.** Do that plumbing refactor first; everything else hangs
off it.

What's already in our favor:
- Daytona backend already creates + disposes an isolated sandbox per session.
  Execution isolation is done; only account/billing isolation was ever open.
- Providers already parse token usage (`providers/claude.ts:66`) — a metering
  hook exists if we ever want it.
- Auth already has HMAC-signed cookie machinery (`api/auth.ts`) — we extend the
  payload to carry `userId`, we don't rewrite it.

---

## Phase 0 — Credential threading + the Identity port (spine, no user-facing change)

De-risks every later phase. Ship it before anyone signs up. This phase **is** the
`Identity` port from [`multi-user-architecture.md`](multi-user-architecture.md):
introduce the interface + a behavior-identical `LocalIdentity` adapter, and move
the orchestrator to resolve principal + credentials through it. Tenancy (Phases
1/3/4/5) then lands entirely as the hosted adapter, and the core stops changing.

- Introduce a per-session **credential context** on `AgentSessionSettings` (or a
  sibling passed into `runSession`): `{ githubToken?, llmKey? }`.
- `providers/pi.ts` takes the key from context, **falls back** to host env.
- `backends/daytona.ts` clone + `github/liaison.ts` push take the GitHub token
  from context, fall back to `gh auth token`.
- No behavior change single-tenant; now the source of every secret is one seam.

## Phase 1 — Accounts & SSO auth (SSO-only, hand-rolled)

Login is **GitHub + Google SSO only** — no passwords, no email provider, none of
the reset/verify machinery. OAuth is hand-rolled in `packages/tenancy` (the
`TenancyIdentity` adapter of the Identity port).

- **Postgres + a thin `db` module.** Tables:
  - `users` (id, email, name, avatar_url, stripe_customer_id,
    subscription_status, token_version, created_at) — **no password_hash**.
  - `identity_links` (provider ∈ {github, google}, provider_user_id, user_id,
    access data) — one user may link both providers; merged on **verified** email.
- **Hand-rolled OAuth2/OIDC** per provider: authorize redirect with `state`
  (+ PKCE), callback → token exchange → fetch profile → upsert `users` +
  `identity_links` → issue our session cookie. Security we own: `state` CSRF
  check, exact redirect-URI match, and **no auto-link on unverified email**.
- **`TenancyIdentity`** implements the same `Identity` port: `resolvePrincipal`
  verifies the session cookie **or** a Bearer API key → the user;
  `resolveCredentials` comes online in Phases 3/4. Cookie payload carries
  `{ userId, tokenVersion, exp }`; bumping `token_version` is logout-everywhere.
- **API keys** (`api_keys`: user_id, key_hash, prefix, last_used_at) — the Bearer
  path in `resolvePrincipal`, so the programmatic API works from day one.
- **Console:** the PIN screen becomes "Continue with GitHub / Google"; add an
  Account settings pane (linked providers, API keys).
- **GitHub note:** prefer the GitHub App's user-to-server OAuth so "Sign in with
  GitHub" *also* bootstraps repo access (Phase 3), rather than a separate OAuth
  app. Google is login-only.

## Phase 2 — Per-user data scoping

- Add `ownerUserId` to `Conversation`; `state/store.ts` list/get/create scope by
  user. Directory layout `conversations/<userId>/<convId>/` (cleaner on the
  volume) or filter in-app.
- Every `/api` route is already gated by a valid session; now also enforce
  **ownership** (a user can only see/act on their conversations).
- This ships atomically with hosted accounts. There must never be a deployment
  where a second user can authenticate against the unscoped conversation store.

## Phase 2.5 — Run lifecycle and pooled-sandbox controls

The first safety layer is implemented now, before hosted auth:

- Daytona sandboxes carry an `automations.managed=true` label plus provider-side
  auto-stop and auto-delete intervals.
- `runSession` tracks live backends; SIGTERM/SIGINT stops accepting requests and
  disposes them before process exit.
- Startup reaps labelled sandboxes already in a non-running state.
- `AUTOMATIONS_MAX_CONCURRENT_SESSIONS` enforces a process-wide launch cap and
  returns HTTP 429 at capacity. Local mode remains unlimited when unset.

Before public multi-user launch, replace the in-memory admission counter with a
durable Postgres run registry/queue and add per-user caps. The provider-side
auto-cleanup remains the final defense for SIGKILL or host failure.

## Phase 3 — GitHub App

- Register one GitHub App (we own it); store app id + private key as env/secret.
- **Install flow:** user clicks Install → GitHub callback → store
  `github_installations` (user_id, installation_id, account_login, repo scope).
- **Token minting:** App JWT → installation access token (short-lived, cached
  until expiry) per user. Feed into the Phase-0 credential context.
- Repo / branch / issue autocomplete (`api/server.ts` github routes) now query
  the **user's installation**, not host `gh`.
- Remove the host `gh` dependency in prod paths.

## Phase 4 — BYOK LLM keys

- **Encrypted secret storage:** `user_secrets` (user_id, kind, ciphertext, iv).
  Encrypt at rest with a KMS key or an app-held key from env (rotate-able).
- Account UI to add / rotate / delete the OpenRouter (or Anthropic) key; show
  last4 only, never echo.
- Inject into the Phase-0 credential context; drop the host-env fallback in prod
  (so a user with no key gets a clear "add your key" error, not our key).

## Phase 5 — Payments

- **Stripe Checkout** for the subscription (flat or per-seat) + **Customer
  Portal** for self-serve management.
- `users.stripe_customer_id` + `subscription_status`; **webhooks** keep status in
  sync (source of truth = Stripe).
- **Gate launching a run** on `subscription_status ∈ {active, trialing}` (or a
  free-tier cap). Because BYOK, this is a pure entitlement check — no usage math.
- Optional: **sandbox-minute metering** (time Daytona prepare→dispose per user).
  Concurrency caps are mandatory and already established in Phase 2.5.

## Phase 6 — Launch hardening

- Rate limiting + abuse protection on auth + launch endpoints.
- Secret encryption via KMS; audit of what lands in logs (redaction already
  exists — extend to new secrets).
- Onboarding: connect-GitHub + add-key wizard on first login.
- Legal: ToS, privacy policy, data-deletion path.
- Observability: per-user error/usage dashboards; Stripe + email alerting.

---

## Cross-cutting risks

- **Railway filesystem is ephemeral** — conversation logs need a mounted volume;
  Postgres is the Railway add-on. Confirm both before Phase 1.
- **GitHub App token latency/caching** — mint-per-request will hit rate limits;
  cache installation tokens until ~expiry.
- **Secret-at-rest key management** — a single app-held encryption key is a
  single point of compromise; plan KMS from Phase 4.
- **Multi-tenant Daytona blast radius** — one bad actor can exhaust the pooled
  org. Phase 2.5's global and per-user caps must precede public access.

## Suggested order to actually build

`Phase 0 → 1+2 → 2.5 → 3 → 4 → 5`. Accounts and ownership scoping ship as one
unit; exposing hosted accounts before scoping would expose cross-user data.
Durable admission control lands before pooled sandboxes are public. GitHub and
BYOK then make signed-in users able to run, followed by monetization. Phase 6
runs alongside from Phase 3 on.
