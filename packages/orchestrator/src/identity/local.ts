/**
 * LocalIdentity — the single-operator adapter. Behavior-identical to how the app
 * worked before the Identity port existed:
 *   • one principal ("local"), gated by the existing shared-PIN auth (api/auth.ts)
 *   • credentials from the host: OPENROUTER_API_KEY + `gh auth token`
 *
 * Empty/absent secrets are OMITTED (not returned as ""), so the runner's own
 * host-env / `gh` fallbacks still engage — nothing here makes local runs stricter
 * than they were.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IncomingMessage } from "node:http";
import type { Credentials } from "@automations/core";
import { isAuthenticated } from "../api/auth.ts";
import type { Identity, Principal } from "./index.ts";

const execFileAsync = promisify(execFile);

/** The one and only principal in local mode; its id is also the data-scope key. */
const LOCAL_PRINCIPAL: Principal = { id: "local" };

/** The host `gh` CLI's token, or undefined if gh is absent / signed out. */
async function ghAuthToken(): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token"], { timeout: 10_000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export class LocalIdentity implements Identity {
  readonly kind = "local";

  async resolvePrincipal(req: IncomingMessage): Promise<Principal | null> {
    // The existing PIN gate IS local auth; reuse it verbatim so nothing changes.
    return isAuthenticated(req) ? LOCAL_PRINCIPAL : null;
  }

  async resolveCredentials(_principal: Principal): Promise<Credentials> {
    const githubToken = await ghAuthToken();
    const llmKey = process.env.OPENROUTER_API_KEY?.trim() || undefined;
    return {
      ...(githubToken ? { githubToken } : {}),
      ...(llmKey ? { llmKey } : {}),
    };
  }

  logStatus(write: (line: string) => void): void {
    write("identity: local (single operator; credentials from host env + gh CLI)\n");
  }
}
