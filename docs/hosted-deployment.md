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
GITHUB_APP_ID=...
GITHUB_APP_SLUG=your-github-app-slug
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...

DAYTONA_API_KEY=...
AUTOMATIONS_MAX_CONCURRENT_SESSIONS=4
```

Configure these exact OAuth callback URLs:

- GitHub: `https://your-site.example/api/auth/github/callback`
- Google: `https://your-site.example/api/auth/google/callback`

Create a separate GitHub App for repository access:

- Setup URL: `https://your-site.example/api/github/setup`
- Redirect on update: enabled
- Webhooks: disabled unless another feature needs them
- Repository permissions:
  - Contents: Read and write
  - Pull requests: Read and write
  - Issues: Read and write (PR/issue comments)
  - Metadata: Read-only (automatic)
- Installation: allow the user to choose all or selected repositories

Generate a private key from the GitHub App settings and put its complete PEM
contents in `GITHUB_APP_PRIVATE_KEY`. Railway accepts either literal newlines or
`\n` escapes.

The server creates its identity tables and indexes idempotently at startup.
The Postgres role therefore needs schema-creation permission on first boot.

## Behavior

- GitHub and Google profiles must expose a provider-verified email.
- Verified identities with the same email link to the same user.
- GitHub login requests `read:org` and imports all visible organization
  memberships into the organization picker. Existing users must sign out and
  authorize GitHub again once after this scope is introduced.
- Repository access is a separate one-time GitHub App installation. Installation
  records persist; the server mints one-hour installation tokens on demand for
  repository listing, clone/push, pull requests, and comments.
- Browser sessions are opaque random tokens; only their SHA-256 hashes are
  stored in Postgres.
- API keys are shown once and likewise stored only as hashes. Use one with
  `Authorization: Bearer aut_...`.
- Conversations are scoped to their owner. Legacy unowned conversations remain
  visible only to local mode's `local` principal.
- Hosted mode rejects local checkout targets and non-Daytona backends.

## Not yet supplied by hosted identity

The encrypted BYOK LLM-key vault remains a separate phase. Hosted users can
connect repositories, but agent execution still needs the LLM credential path
before it is fully self-service.
