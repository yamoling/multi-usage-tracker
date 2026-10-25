// Meta Muse Code usage client. Reads the sign-in the Muse CLI keeps in
// $XDG_CONFIG_HOME/muse/auth.json (default ~/.config/muse) and makes the same
// call as `muse usage`: POST api.meta.ai/muse-code/key, whose answer carries
// the account, the subscription tier, and the usage snapshot. Read-only like
// the Codex client: the token is never refreshed or written back.
// Pure GI: no shell imports, so it runs under plain `gjs` (tools/poll-muse.js).

import GLib from "gi://GLib";

import { SignedOutError } from "./errors.js";
import { newSession, requestJson, loadJsonFile } from "./http.js";

export const MUSE_KEY_URL = "https://api.meta.ai/muse-code/key";
export const MUSE_ACCOUNT_URL = "https://accountscenter.meta.com/muse_code/";

// The directory the Muse CLI keeps auth.json and settings.json in.
export function defaultMuseConfigDir() {
  return GLib.build_filenamev([GLib.get_user_config_dir(), "muse"]);
}

export class MuseClient {
  constructor({ configDir = defaultMuseConfigDir() } = {}) {
    this._configDir = configDir;
    this._session = newSession();
  }

  /**
   * {accessToken, email, name} of the active provider in auth.json. Throws
   * SignedOutError when the CLI has no usable sign-in.
   * @ai-generated
   */
  async readAuth() {
    let root;
    try {
      root = await loadJsonFile(GLib.build_filenamev([this._configDir, "auth.json"]));
    } catch {
      throw new SignedOutError("Not signed in. Run `muse login` to sign in to Muse Code.");
    }
    let provider = "meta";
    try {
      const settings = await loadJsonFile(GLib.build_filenamev([this._configDir, "settings.json"]));
      provider = settings?.provider || provider;
    } catch {
      // No settings yet: the CLI defaults to the meta provider.
    }
    const entry = root?.providers?.[provider] ?? root?.providers?.meta;
    if (!entry?.access_token) {
      throw new SignedOutError(
        entry?.api_key
          ? "Muse Code is using an API key. Usage limits need a subscription sign-in (`muse login`)."
          : "Not signed in. Run `muse login` to sign in to Muse Code.",
      );
    }
    return {
      accessToken: entry.access_token,
      email: entry.user_email ?? null,
      name: entry.user_full_name ?? null,
      subscribed: entry.subs_active ?? null,
    };
  }

  // The key/subscription record, including subs_usage (see museModel.js).
  async fetchUsage(cancellable = null) {
    const auth = await this.readAuth();
    return requestJson(this._session, "POST", MUSE_KEY_URL, {
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        "x-api-version": "1.0.0",
        "User-Agent": "muse-build/0.1.0",
      },
      jsonBody: { onboard: false },
      cancellable,
    });
  }
}
