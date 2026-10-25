// The Codex (ChatGPT) account signed in through the Codex CLI.

import { CodexClient } from "../../lib/codexClient.js";
import { normalizeCodexWindows, normalizeResetCredits, codexCredits, codexPlanLabel } from "../../lib/codexModel.js";
import { humanDuration } from "../../lib/format.js";
import { UsageView } from "../usageView.js";

export class CodexView extends UsageView {
  constructor(settings, panelBox, sectionsBox, path) {
    super(
      {
        name: "Codex",
        logoFile: `${path}/icons/codex.png`,
        logTag: "codex-usage",
        pillClass: "cu-pill cu-pill-codex",
        messages: {
          expired: "Codex session expired. Run `codex` once to refresh its sign-in.",
          forbidden: "No active ChatGPT subscription for this account.",
          rateLimited: "Rate limited by ChatGPT; will retry shortly.",
          unreachable: "Could not reach ChatGPT",
        },
      },
      settings,
      panelBox,
      sectionsBox,
      true,
    );
    this._client = new CodexClient();
  }

  // The plan is also in the id_token claims on disk, so the pill can show
  // before the first request returns.
  async applyTierFromDisk(cancellable) {
    try {
      const { plan } = await this._client.readAuth();
      if (cancellable.is_cancelled() || !plan || this._lastUsage) return;
      this._setTier(codexPlanLabel(plan));
    } catch {
      // Not signed in; the refresh shows the signed-out state.
    }
  }

  // Never rejects; errors are rendered in the section.
  async refresh(cancellable) {
    let result;
    try {
      result = await this._client.fetchUsage(cancellable);
    } catch (e) {
      if (!cancellable.is_cancelled()) this._renderError(e);
      return;
    }
    if (cancellable.is_cancelled()) return;
    this._render(result);
  }

  _render({ usage, resetCredits, account }) {
    this._error.visible = false;
    this._lastUsage = usage;

    this._setTier(codexPlanLabel(usage.plan_type ?? account.plan));
    const parts = [account.email || usage.email || "ChatGPT"];
    if (usage.rate_limit?.limit_reached) parts.push("limit reached");
    this._subtitle.text = parts.join(" · ");

    this._renderWindows(normalizeCodexWindows(usage));

    const lines = [];
    const credits = codexCredits(usage);
    if (credits) lines.push(`Credits: ${credits}`);
    const resets = normalizeResetCredits(usage, resetCredits);
    if (resets) {
      let line = `Banked resets: ${resets.count}`;
      const next = resets.expiries[0];
      if (next && Date.parse(next) > Date.now())
        line += ` · ${resets.count > 1 ? "next " : ""}expires in ${humanDuration((Date.parse(next) - Date.now()) / 1000)}`;
      lines.push(line);
    }
    this._setExtra(lines);

    this.renderPanel();
    this.lastResult = "ok";
  }
}
