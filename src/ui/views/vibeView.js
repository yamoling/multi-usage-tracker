// The Mistral account whose admin.mistral.ai session is stored in settings.

import { VibeClient } from "../../lib/vibeClient.js";
import { normalizeVibeWindows, vibeSpendLines, vibePlanLabel, vibeAccountName } from "../../lib/vibeModel.js";
import { UsageView } from "../usageView.js";

export class VibeView extends UsageView {
  constructor(settings, panelBox, sectionsBox, path) {
    super(
      {
        name: "Mistral Vibe",
        logoFile: `${path}/icons/vibe.svg`,
        logTag: "vibe-usage",
        pillClass: "cu-pill cu-pill-vibe",
        messages: {
          expired: "admin.mistral.ai session expired. Paste a fresh one in Settings.",
          rateLimited: "Rate limited by Mistral; will retry shortly.",
          unreachable: "Could not reach admin.mistral.ai",
        },
      },
      settings,
      panelBox,
      sectionsBox,
      true,
    );
    this._client = new VibeClient({ settings });
  }

  /**
   * Fetches the budgets and, best-effort, the account for the header. Never
   * rejects; errors are rendered in the section.
   * @ai-generated
   */
  async refresh(cancellable) {
    const [budgetRes, sessionRes] = await Promise.allSettled([this._client.fetchBudget(cancellable), this._client.fetchSession(cancellable)]);
    if (cancellable.is_cancelled()) return;
    if (budgetRes.status === "rejected") {
      this._renderError(budgetRes.reason);
      return;
    }
    if (sessionRes.status === "rejected") logError(sessionRes.reason, "vibe-usage: account fetch failed (non-fatal)");
    this._render(budgetRes.value, sessionRes.status === "fulfilled" ? sessionRes.value : null);
  }

  _render(budget, session) {
    this._error.visible = false;
    this._lastUsage = budget;

    if (session) {
      this._setTier(vibePlanLabel(session));
      this._subtitle.text = vibeAccountName(session) ?? "Mistral";
    }

    this._renderWindows(normalizeVibeWindows(budget));
    this._setExtra(vibeSpendLines(budget));

    this.renderPanel();
    this.lastResult = "ok";
  }
}
