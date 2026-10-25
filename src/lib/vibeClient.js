// Mistral Vibe usage client. The Vibe CLI's own credential (a Mistral API key)
// cannot see the subscription allowance, so this reads the same tRPC routes
// admin.mistral.ai/subscription renders from, authenticated with that site's
// browser session cookie (`ory_session_…`), which the user pastes into prefs.
// The session lasts about three months and is only read, never renewed.
// Pure GI: no shell imports, so it runs under plain `gjs` (tools/poll-vibe.js).

import { UsageError, SignedOutError } from "./errors.js";
import { newSession, requestJson } from "./http.js";
import { unwrapTrpc, parseSessionCookie } from "./vibeModel.js";

export const VIBE_ADMIN_URL = "https://admin.mistral.ai";
export const VIBE_SUBSCRIPTION_URL = `${VIBE_ADMIN_URL}/subscription`;
// Name of the session cookie when the user pastes only its value.
export const VIBE_DEFAULT_COOKIE_NAME = "ory_session_coolcurranf83m3srkfl";
export const VIBE_COOKIE_KEY = "vibe-session-cookie";

// tRPC GET input for a procedure that takes no arguments (superjson-encoded).
const NO_INPUT = encodeURIComponent(JSON.stringify({ json: null, meta: { values: ["undefined"], v: 1 } }));

export class VibeClient {
  /**
   * @param {object} opts
   * @param {Gio.Settings} [opts.settings] Source of the stored cookie.
   * @param {string} [opts.cookie]         Explicit cookie, overrides settings.
   * @ai-generated
   */
  constructor({ settings = null, cookie = null } = {}) {
    this._settings = settings;
    this._cookie = cookie;
    this._session = newSession();
  }

  _cookieHeader() {
    const raw = this._cookie ?? this._settings?.get_string(VIBE_COOKIE_KEY) ?? "";
    const cookie = parseSessionCookie(raw, VIBE_DEFAULT_COOKIE_NAME);
    if (!cookie) throw new SignedOutError("Not connected. Paste your admin.mistral.ai session in the extension settings.");
    return cookie;
  }

  /**
   * Calls one admin.mistral.ai tRPC query and returns its payload. An invalid
   * session is answered with an Ory login flow (HTTP 200) rather than a 401,
   * so a body that is not a tRPC result is reported as a 401.
   * @ai-generated
   */
  async _query(procedure, cancellable) {
    const url = `${VIBE_ADMIN_URL}/api/local-trpc/${procedure}?input=${NO_INPUT}`;
    const body = await requestJson(this._session, "GET", url, {
      headers: { Cookie: this._cookieHeader(), "User-Agent": "multi-usage-tracker (GNOME Shell extension)" },
      cancellable,
    });
    const payload = unwrapTrpc(body);
    if (payload === undefined) throw new UsageError(`Not signed in to ${VIBE_ADMIN_URL}`, { status: 401, body: JSON.stringify(body) });
    return payload;
  }

  // The budgets payload: {api_budget, vibe_budget, ...}.
  fetchBudget(cancellable = null) {
    return this._query("billing.budget", cancellable);
  }

  // The signed-in user and organisation (name, plan).
  fetchSession(cancellable = null) {
    return this._query("user.meSession", cancellable);
  }
}
