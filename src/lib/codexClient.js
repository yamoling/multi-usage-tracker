// Codex (ChatGPT) usage client. Reads the token the Codex CLI keeps in
// $CODEX_HOME/auth.json (default ~/.codex) and calls the ChatGPT backend that
// the CLI's own /status uses. Pure GI like usageClient.js: no shell imports, so
// it runs under plain `gjs` (tools/poll-codex.js) as well as in the shell.
//
// The token is only read, never refreshed or written back: the Codex CLI
// rotates its refresh token on use, and a second writer racing it could sign
// the CLI out. When the access token lapses the popup asks to run `codex`.

import GLib from "gi://GLib";

import { SignedOutError } from "./errors.js";
import { newSession, requestJson, loadJsonFile } from "./http.js";
import { decoder } from "./oauth.js";

export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
export const CODEX_RESET_CREDITS_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";

// The directory the Codex CLI keeps auth.json in: $CODEX_HOME, else ~/.codex.
export function defaultCodexHome() {
  return GLib.getenv("CODEX_HOME") || GLib.build_filenamev([GLib.get_home_dir(), ".codex"]);
}

// Payload of a JWT (unverified; only used for display), or null.
function jwtClaims(token) {
  try {
    const part = String(token ?? "").split(".")[1];
    if (!part) return null;
    let b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    b64 += "=".repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(decoder.decode(GLib.base64_decode(b64)));
  } catch {
    return null;
  }
}

export class CodexClient {
  constructor({ codexHome = defaultCodexHome() } = {}) {
    this._codexHome = codexHome;
    this._session = newSession();
  }

  // {accessToken, accountId, email, plan} from auth.json. Throws
  // SignedOutError when there is no ChatGPT sign-in to use.
  async readAuth() {
    let root;
    try {
      root = await loadJsonFile(GLib.build_filenamev([this._codexHome, "auth.json"]));
    } catch {
      throw new SignedOutError("Not signed in. Run `codex login` to sign in with ChatGPT.");
    }
    const tokens = root?.tokens ?? root;
    if (!tokens?.access_token) {
      // An API-key login has no subscription limits to report.
      throw new SignedOutError(
        root?.OPENAI_API_KEY
          ? "Codex is using an API key. Usage limits need a ChatGPT sign-in (`codex login`)."
          : "Not signed in. Run `codex login` to sign in with ChatGPT.",
      );
    }
    const claims = jwtClaims(tokens.id_token) ?? {};
    const auth = claims["https://api.openai.com/auth"] ?? {};
    return {
      accessToken: tokens.access_token,
      accountId: tokens.account_id ?? auth.chatgpt_account_id ?? null,
      email: claims.email ?? null,
      plan: auth.chatgpt_plan_type ?? null,
    };
  }

  _get(url, auth, cancellable) {
    return requestJson(this._session, "GET", url, {
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        "User-Agent": "codex-cli",
        "ChatGPT-Account-Id": auth.accountId,
      },
      cancellable,
    });
  }

  // Resolves to {usage, resetCredits, account}. resetCredits is the detail
  // list of banked resets, only fetched when the usage payload says there are
  // any (saves a request per poll); a failure there is non-fatal.
  async fetchUsage(cancellable = null) {
    const auth = await this.readAuth();
    const usage = await this._get(CODEX_USAGE_URL, auth, cancellable);
    let resetCredits = null;
    if (Number(usage?.rate_limit_reset_credits?.available_count) > 0) {
      try {
        resetCredits = await this._get(CODEX_RESET_CREDITS_URL, auth, cancellable);
      } catch (e) {
        if (cancellable?.is_cancelled()) throw e;
        logError(e, "codex-usage: reset-credit details unavailable (non-fatal)");
      }
    }
    return { usage, resetCredits, account: { email: auth.email, plan: auth.plan } };
  }
}
