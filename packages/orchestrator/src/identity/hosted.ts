import { createHash, createSign, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Pool } from "pg";
import type { Credentials } from "@automations/core";
import type { Identity, Principal } from "./index.ts";

type Provider = "github" | "google";
interface UserPrincipal extends Principal {
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

const SESSION_COOKIE = "automations_session";
const OAUTH_COOKIE = "automations_oauth";
const SESSION_TTL_MS = Math.max(1, Number(process.env.AUTH_SESSION_TTL_HOURS ?? 720)) * 3_600_000;
const API_PREFIX = "aut_";

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");

function cookies(req: IncomingMessage): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) result[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return result;
}

function secure(req: IncomingMessage): boolean {
  const value = req.headers["x-forwarded-proto"];
  return (Array.isArray(value) ? value[0] : value) === "https";
}

function cookie(name: string, value: string, req: IncomingMessage, maxAge: number): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAge}`,
    ...(secure(req) ? ["Secure"] : []),
  ].join("; ");
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`OAuth request failed (${response.status})`);
  return response.json() as Promise<T>;
}

export class HostedIdentity implements Identity {
  readonly kind = "hosted";
  private readonly pool: Pool;
  private readonly publicUrl: string;
  readonly ready: Promise<void>;

  constructor() {
    const connectionString = process.env.DATABASE_URL?.trim();
    if (!connectionString) throw new Error("IDENTITY_MODE=hosted requires DATABASE_URL");
    this.publicUrl = (process.env.PUBLIC_URL?.trim() || "").replace(/\/$/, "");
    if (!this.publicUrl) throw new Error("IDENTITY_MODE=hosted requires PUBLIC_URL");
    this.pool = new Pool({
      connectionString,
      ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
    });
    this.ready = this.ensureSchema();
  }

  private async ensureSchema(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email text NOT NULL UNIQUE,
        name text,
        avatar_url text,
        token_version integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS identity_links (
        provider text NOT NULL CHECK (provider IN ('github','google')),
        provider_user_id text NOT NULL,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        provider_login text,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (provider, provider_user_id)
      );
      CREATE TABLE IF NOT EXISTS user_sessions (
        token_hash text PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS oauth_flows (
        state_hash text PRIMARY KEY,
        provider text NOT NULL CHECK (provider IN ('github','google')),
        verifier text NOT NULL,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS api_keys (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key_hash text NOT NULL UNIQUE,
        prefix text NOT NULL,
        name text NOT NULL,
        last_used_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS user_github_orgs (
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        github_org_id bigint NOT NULL,
        login text NOT NULL,
        avatar_url text,
        imported_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, github_org_id)
      );
      CREATE TABLE IF NOT EXISTS github_install_flows (
        state_hash text PRIMARY KEY,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at timestamptz NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS user_github_installations (
        installation_id bigint NOT NULL,
        user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        account_login text NOT NULL,
        account_type text NOT NULL,
        repository_selection text NOT NULL,
        suspended_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, installation_id)
      );
      CREATE INDEX IF NOT EXISTS user_github_installations_account_idx
        ON user_github_installations(user_id, lower(account_login));
      CREATE INDEX IF NOT EXISTS user_sessions_user_id_idx ON user_sessions(user_id);
      CREATE INDEX IF NOT EXISTS api_keys_user_id_idx ON api_keys(user_id);
    `);
  }

  async resolvePrincipal(req: IncomingMessage): Promise<UserPrincipal | null> {
    await this.ready;
    const authorization = req.headers.authorization;
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    if (bearer) {
      const result = await this.pool.query(
        `UPDATE api_keys k SET last_used_at=now()
         FROM users u WHERE k.key_hash=$1 AND u.id=k.user_id
         RETURNING u.id,u.email,u.name,u.avatar_url`,
        [sha256(bearer)],
      );
      return this.principal(result.rows[0]);
    }
    const token = cookies(req)[SESSION_COOKIE];
    if (!token) return null;
    const result = await this.pool.query(
      `SELECT u.id,u.email,u.name,u.avatar_url FROM user_sessions s
       JOIN users u ON u.id=s.user_id
       WHERE s.token_hash=$1 AND s.expires_at>now()`,
      [sha256(token)],
    );
    return this.principal(result.rows[0]);
  }

  private principal(row: unknown): UserPrincipal | null {
    if (!row || typeof row !== "object") return null;
    const value = row as Record<string, unknown>;
    if (typeof value.id !== "string" || typeof value.email !== "string") return null;
    return {
      id: value.id,
      email: value.email,
      name: typeof value.name === "string" ? value.name : null,
      avatarUrl: typeof value.avatar_url === "string" ? value.avatar_url : null,
    };
  }

  async resolveCredentials(_principal: Principal): Promise<Credentials> {
    return {};
  }

  async resolveCredentialsForRepo(principal: Principal, repo: string): Promise<Credentials> {
    const owner = repo.split("/")[0]?.trim();
    if (!owner) throw new Error("GitHub repository must be owner/name");
    const installation = await this.installationForOwner(principal.id, owner);
    if (!installation) throw new Error(`GitHub App is not installed for ${owner}`);
    return { githubToken: await this.installationToken(installation.installationId) };
  }

  async sessionInfo(req: IncomingMessage): Promise<Record<string, unknown>> {
    const principal = await this.resolvePrincipal(req);
    return { authenticated: !!principal, required: true, mode: "hosted", user: principal };
  }

  async beginOAuth(provider: Provider, req: IncomingMessage, res: ServerResponse): Promise<string> {
    await this.ready;
    const clientId = this.clientId(provider);
    const state = randomToken();
    const verifier = randomToken(48);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    await this.pool.query("DELETE FROM oauth_flows WHERE expires_at<=now()");
    await this.pool.query(
      "INSERT INTO oauth_flows(state_hash,provider,verifier,expires_at) VALUES($1,$2,$3,now()+interval '10 minutes')",
      [sha256(state), provider, verifier],
    );
    res.setHeader("Set-Cookie", cookie(OAUTH_COOKIE, state, req, 600));
    const redirectUri = `${this.publicUrl}/api/auth/${provider}/callback`;
    const endpoint = provider === "github" ? "https://github.com/login/oauth/authorize" : "https://accounts.google.com/o/oauth2/v2/auth";
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: provider === "github" ? "read:user user:email read:org" : "openid email profile",
      ...(provider === "google" ? { response_type: "code", access_type: "online", prompt: "select_account" } : {}),
    });
    return `${endpoint}?${params}`;
  }

  async completeOAuth(provider: Provider, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    await this.ready;
    const storedState = cookies(req)[OAUTH_COOKIE];
    const returnedState = url.searchParams.get("state");
    if (!storedState || !returnedState || storedState !== returnedState) {
      throw new Error("OAuth state mismatch");
    }
    const stored = await this.pool.query(
      `DELETE FROM oauth_flows WHERE state_hash=$1 AND provider=$2 AND expires_at>now()
       RETURNING verifier`,
      [sha256(returnedState), provider],
    );
    const verifier = stored.rows[0]?.verifier;
    if (typeof verifier !== "string") throw new Error("OAuth flow is missing, expired, or already used");
    const code = url.searchParams.get("code");
    if (!code) throw new Error(url.searchParams.get("error_description") || "OAuth code is missing");
    const profile = provider === "github"
      ? await this.githubProfile(code, verifier)
      : await this.googleProfile(code, verifier);
    if (!profile.emailVerified) throw new Error(`${provider} did not provide a verified email`);

    const client = await this.pool.connect();
    let userId: string;
    try {
      await client.query("BEGIN");
      const linked = await client.query(
        "SELECT user_id FROM identity_links WHERE provider=$1 AND provider_user_id=$2",
        [provider, profile.providerUserId],
      );
      if (linked.rows[0]?.user_id) {
        userId = String(linked.rows[0].user_id);
        await client.query("UPDATE users SET email=$2,name=$3,avatar_url=$4,updated_at=now() WHERE id=$1", [
          userId, profile.email, profile.name, profile.avatarUrl,
        ]);
      } else {
        const user = await client.query(
          `INSERT INTO users(email,name,avatar_url) VALUES($1,$2,$3)
           ON CONFLICT(email) DO UPDATE SET name=EXCLUDED.name,avatar_url=EXCLUDED.avatar_url,updated_at=now()
           RETURNING id`,
          [profile.email, profile.name, profile.avatarUrl],
        );
        userId = String(user.rows[0].id);
        await client.query(
          "INSERT INTO identity_links(provider,provider_user_id,user_id,provider_login) VALUES($1,$2,$3,$4)",
          [provider, profile.providerUserId, userId, profile.login],
        );
      }
      if (provider === "github") {
        await client.query("DELETE FROM user_github_orgs WHERE user_id=$1", [userId]);
        for (const org of profile.organizations) {
          await client.query(
            `INSERT INTO user_github_orgs(user_id,github_org_id,login,avatar_url)
             VALUES($1,$2,$3,$4)`,
            [userId, org.id, org.login, org.avatarUrl],
          );
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    const token = randomToken();
    await this.pool.query("INSERT INTO user_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)", [
      sha256(token), userId, new Date(Date.now() + SESSION_TTL_MS),
    ]);
    res.setHeader("Set-Cookie", [
      cookie(SESSION_COOKIE, token, req, Math.floor(SESSION_TTL_MS / 1000)),
      cookie(OAUTH_COOKIE, "", req, 0),
    ]);
  }

  async logout(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const token = cookies(req)[SESSION_COOKIE];
    if (token) await this.pool.query("DELETE FROM user_sessions WHERE token_hash=$1", [sha256(token)]);
    res.setHeader("Set-Cookie", cookie(SESSION_COOKIE, "", req, 0));
  }

  async listApiKeys(userId: string): Promise<unknown[]> {
    const result = await this.pool.query(
      "SELECT id,name,prefix,created_at,last_used_at FROM api_keys WHERE user_id=$1 ORDER BY created_at DESC",
      [userId],
    );
    return result.rows;
  }

  async createApiKey(userId: string, name: string): Promise<Record<string, unknown>> {
    const raw = `${API_PREFIX}${randomToken()}`;
    const prefix = raw.slice(0, 12);
    const result = await this.pool.query(
      "INSERT INTO api_keys(user_id,key_hash,prefix,name) VALUES($1,$2,$3,$4) RETURNING id,name,prefix,created_at",
      [userId, sha256(raw), prefix, name.trim() || "API key"],
    );
    return { ...result.rows[0], key: raw };
  }

  async revokeApiKey(userId: string, id: string): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM api_keys WHERE id::text=$1 AND user_id=$2", [id, userId]);
    return (result.rowCount ?? 0) > 0;
  }

  async listGithubOrgs(userId: string): Promise<{ orgs: string[]; lastOrg: null; connectedOwners: string[] }> {
    const [organizations, account] = await Promise.all([
      this.pool.query(
        "SELECT login FROM user_github_orgs WHERE user_id=$1 ORDER BY lower(login)",
        [userId],
      ),
      this.pool.query(
        `SELECT provider_login FROM identity_links
         WHERE user_id=$1 AND provider='github' LIMIT 1`,
        [userId],
      ),
    ]);
    const orgs = organizations.rows.map((row) => String(row.login));
    const personalAccount = account.rows[0]?.provider_login;
    if (typeof personalAccount === "string" && !orgs.includes(personalAccount)) {
      orgs.push(personalAccount);
    }
    const installations = await this.pool.query(
      "SELECT account_login FROM user_github_installations WHERE user_id=$1 AND suspended_at IS NULL",
      [userId],
    );
    return {
      orgs,
      lastOrg: null,
      connectedOwners: installations.rows.map((row) => String(row.account_login)),
    };
  }

  async beginGithubInstall(userId: string): Promise<string> {
    await this.ready;
    const slug = process.env.GITHUB_APP_SLUG?.trim();
    if (!slug) throw new Error("GITHUB_APP_SLUG is not configured");
    const state = randomToken();
    await this.pool.query("DELETE FROM github_install_flows WHERE expires_at<=now()");
    await this.pool.query(
      "INSERT INTO github_install_flows(state_hash,user_id,expires_at) VALUES($1,$2,now()+interval '15 minutes')",
      [sha256(state), userId],
    );
    return `https://github.com/apps/${encodeURIComponent(slug)}/installations/new?state=${encodeURIComponent(state)}`;
  }

  async completeGithubInstall(userId: string, url: URL): Promise<void> {
    await this.ready;
    const state = url.searchParams.get("state");
    const rawInstallationId = url.searchParams.get("installation_id");
    if (!state || !rawInstallationId || !/^\d+$/.test(rawInstallationId)) {
      throw new Error("GitHub installation callback is missing state or installation_id");
    }
    const flow = await this.pool.query(
      `DELETE FROM github_install_flows
       WHERE state_hash=$1 AND user_id=$2 AND expires_at>now()
       RETURNING user_id`,
      [sha256(state), userId],
    );
    if (!flow.rowCount) throw new Error("GitHub installation flow is missing, expired, or already used");

    const installation = await this.githubAppRequest<{
      id: number;
      account: { login: string; type: string };
      repository_selection: string;
      suspended_at: string | null;
    }>(`/app/installations/${rawInstallationId}`, { auth: "app" });
    const allowed = await this.pool.query(
      `SELECT 1 FROM identity_links WHERE user_id=$1 AND provider='github' AND lower(provider_login)=lower($2)
       UNION ALL
       SELECT 1 FROM user_github_orgs WHERE user_id=$1 AND lower(login)=lower($2)
       LIMIT 1`,
      [userId, installation.account.login],
    );
    if (!allowed.rowCount) throw new Error(`GitHub installation account ${installation.account.login} is not linked to this user`);
    await this.pool.query(
      `INSERT INTO user_github_installations(
         installation_id,user_id,account_login,account_type,repository_selection,suspended_at
       ) VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(user_id,installation_id) DO UPDATE SET
         account_login=EXCLUDED.account_login,
         account_type=EXCLUDED.account_type,repository_selection=EXCLUDED.repository_selection,
         suspended_at=EXCLUDED.suspended_at,updated_at=now()`,
      [
        installation.id,
        userId,
        installation.account.login,
        installation.account.type,
        installation.repository_selection,
        installation.suspended_at,
      ],
    );
  }

  async listGithubRepos(userId: string, owner: string): Promise<string[]> {
    const installation = await this.installationForOwner(userId, owner);
    if (!installation) throw new Error(`GitHub App is not installed for ${owner}`);
    const token = await this.installationToken(installation.installationId);
    const repositories: string[] = [];
    for (let page = 1; ; page += 1) {
      const result = await this.githubAppRequest<{
        repositories: Array<{ full_name: string }>;
      }>(`/installation/repositories?per_page=100&page=${page}`, { token });
      repositories.push(...result.repositories.map((repo) => repo.full_name));
      if (result.repositories.length < 100) break;
    }
    return repositories
      .filter((repo) => repo.toLowerCase().startsWith(`${owner.toLowerCase()}/`))
      .sort((a, b) => a.localeCompare(b));
  }

  async listGithubIssues(userId: string, repo: string): Promise<unknown[]> {
    const owner = repo.split("/")[0] ?? "";
    const installation = await this.installationForOwner(userId, owner);
    if (!installation) throw new Error(`GitHub App is not installed for ${owner}`);
    const token = await this.installationToken(installation.installationId);
    const issues = await this.githubAppRequest<Array<Record<string, unknown>>>(
      `/repos/${repo}/issues?state=open&per_page=100`,
      { token },
    );
    return issues
      .filter((issue) => !issue.pull_request)
      .map((issue) => ({ number: issue.number, title: issue.title, url: issue.html_url }));
  }

  logStatus(write: (line: string) => void): void {
    write("identity: hosted (Postgres + GitHub/Google SSO + API keys)\n");
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private clientId(provider: Provider): string {
    const value = process.env[provider === "github" ? "GITHUB_CLIENT_ID" : "GOOGLE_CLIENT_ID"]?.trim();
    if (!value) throw new Error(`${provider.toUpperCase()}_CLIENT_ID is not configured`);
    return value;
  }

  private clientSecret(provider: Provider): string {
    const value = process.env[provider === "github" ? "GITHUB_CLIENT_SECRET" : "GOOGLE_CLIENT_SECRET"]?.trim();
    if (!value) throw new Error(`${provider.toUpperCase()}_CLIENT_SECRET is not configured`);
    return value;
  }

  private async githubProfile(code: string, verifier: string) {
    const token = await json<{ access_token: string }>("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        client_id: this.clientId("github"),
        client_secret: this.clientSecret("github"),
        code,
        redirect_uri: `${this.publicUrl}/api/auth/github/callback`,
        code_verifier: verifier,
      }),
    });
    const headers = { authorization: `Bearer ${token.access_token}`, accept: "application/vnd.github+json" };
    const [user, emails, organizations] = await Promise.all([
      json<{ id: number; login: string; name: string | null; avatar_url: string | null }>("https://api.github.com/user", { headers }),
      json<Array<{ email: string; primary: boolean; verified: boolean }>>("https://api.github.com/user/emails", { headers }),
      this.githubOrganizations(headers),
    ]);
    const email = emails.find((item) => item.primary && item.verified) ?? emails.find((item) => item.verified);
    if (!email) throw new Error("GitHub account has no verified email available");
    return {
      providerUserId: String(user.id),
      login: user.login,
      email: email.email.toLowerCase(),
      emailVerified: true,
      name: user.name,
      avatarUrl: user.avatar_url,
      organizations: organizations.map((org) => ({ id: org.id, login: org.login, avatarUrl: org.avatar_url })),
    };
  }

  private async githubOrganizations(headers: Record<string, string>) {
    const organizations: Array<{ id: number; login: string; avatar_url: string | null }> = [];
    for (let page = 1; ; page += 1) {
      const batch = await json<typeof organizations>(
        `https://api.github.com/user/orgs?per_page=100&page=${page}`,
        { headers },
      );
      organizations.push(...batch);
      if (batch.length < 100) return organizations;
    }
  }

  private async installationForOwner(userId: string, owner: string): Promise<{ installationId: string } | null> {
    const result = await this.pool.query(
      `SELECT installation_id::text FROM user_github_installations
       WHERE user_id=$1 AND lower(account_login)=lower($2) AND suspended_at IS NULL
       LIMIT 1`,
      [userId, owner],
    );
    return result.rows[0]?.installation_id
      ? { installationId: String(result.rows[0].installation_id) }
      : null;
  }

  private appJwt(): string {
    const appId = process.env.GITHUB_APP_ID?.trim();
    const privateKey = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();
    if (!appId || !privateKey) throw new Error("GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required");
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId })).toString("base64url");
    const input = `${header}.${payload}`;
    const signature = createSign("RSA-SHA256").update(input).sign(privateKey).toString("base64url");
    return `${input}.${signature}`;
  }

  private async githubAppRequest<T>(
    path: string,
    auth: { auth: "app" } | { token: string },
    init: RequestInit = {},
  ): Promise<T> {
    const authorization = "auth" in auth ? `Bearer ${this.appJwt()}` : `Bearer ${auth.token}`;
    return json<T>(`https://api.github.com${path}`, {
      ...init,
      headers: {
        accept: "application/vnd.github+json",
        authorization,
        "x-github-api-version": "2022-11-28",
        ...(init.headers ?? {}),
      },
    });
  }

  private async installationToken(installationId: string): Promise<string> {
    const result = await this.githubAppRequest<{ token: string }>(
      `/app/installations/${installationId}/access_tokens`,
      { auth: "app" },
      { method: "POST" },
    );
    return result.token;
  }

  private async googleProfile(code: string, verifier: string) {
    const token = await json<{ access_token: string }>("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.clientId("google"),
        client_secret: this.clientSecret("google"),
        code,
        code_verifier: verifier,
        grant_type: "authorization_code",
        redirect_uri: `${this.publicUrl}/api/auth/google/callback`,
      }),
    });
    const user = await json<{ sub: string; email: string; email_verified: boolean; name?: string; picture?: string }>(
      "https://openidconnect.googleapis.com/v1/userinfo",
      { headers: { authorization: `Bearer ${token.access_token}` } },
    );
    return {
      providerUserId: user.sub,
      login: user.email,
      email: user.email.toLowerCase(),
      emailVerified: user.email_verified,
      name: user.name ?? null,
      avatarUrl: user.picture ?? null,
      organizations: [],
    };
  }
}
