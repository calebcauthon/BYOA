# Hosted identity deployment

Set `IDENTITY_MODE=hosted` to replace the local PIN/single-principal adapter
with Postgres-backed users. The first successful GitHub or Google login creates
the user automatically; there is no separate signup endpoint.

## Required environment

```dotenv
IDENTITY_MODE=hosted
DATABASE_URL=postgresql://...
PUBLIC_URL=https://your-site.example

GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...

DAYTONA_API_KEY=...
AUTOMATIONS_MAX_CONCURRENT_SESSIONS=4
```

Configure these exact OAuth callback URLs:

- GitHub: `https://your-site.example/api/auth/github/callback`
- Google: `https://your-site.example/api/auth/google/callback`

The server creates its identity tables and indexes idempotently at startup.
The Postgres role therefore needs schema-creation permission on first boot.

## Behavior

- GitHub and Google profiles must expose a provider-verified email.
- Verified identities with the same email link to the same user.
- Browser sessions are opaque random tokens; only their SHA-256 hashes are
  stored in Postgres.
- API keys are shown once and likewise stored only as hashes. Use one with
  `Authorization: Bearer aut_...`.
- Conversations are scoped to their owner. Legacy unowned conversations remain
  visible only to local mode's `local` principal.
- Hosted mode rejects local checkout targets and non-Daytona backends.

## Not yet supplied by hosted identity

SSO establishes identity but does not grant repository access. The GitHub App
installation/token flow and encrypted BYOK LLM-key vault remain separate
phases. Until those are added, hosted users can sign in and manage API keys, but
cannot successfully launch a private-repository agent run with user-owned
credentials.
