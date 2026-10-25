// The Meta account the Muse Code CLI is signed in to.

import { MuseClient } from "../../lib/museClient.js";
import { normalizeMuseWindows, musePlanLabel } from "../../lib/museModel.js";
import { UsageView } from "../usageView.js";

export class MuseView extends UsageView {
  constructor(settings, panelBox, sectionsBox, path) {
    super(
      {
        name: "Muse Code",
        logoFile: `${path}/icons/muse.svg`,
        logTag: "muse-usage",
        pillClass: "cu-pill cu-pill-muse",
        messages: {
          expired: "Muse Code session expired. Run `muse login` to sign in again.",
          forbidden: "No active Muse Code subscription for this account.",
          rateLimited: "Rate limited by Meta; will retry shortly.",
          unreachable: "Could not reach Meta",
        },
      },
      settings,
      panelBox,
      sectionsBox,
      true,
    );
    this._client = new MuseClient();
  }

  // The account name sits in auth.json, so the header can fill in at once.
  async applyTierFromDisk(cancellable) {
    try {
      const { email, name } = await this._client.readAuth();
      if (cancellable.is_cancelled() || this._lastUsage) return;
      this._subtitle.text = name || email || "";
    } catch {
      // Not signed in; the refresh shows the signed-out state.
    }
  }

  // Never rejects; errors are rendered in the section.
  async refresh(cancellable) {
    let info;
    try {
      info = await this._client.fetchUsage(cancellable);
    } catch (e) {
      if (!cancellable.is_cancelled()) this._renderError(e);
      return;
    }
    if (cancellable.is_cancelled()) return;
    this._render(info);
  }

  /**
   * Renders the key record. Only the fields shown are kept: the record also
   * carries an API key, which has no business lingering in memory.
   * @ai-generated
   */
  _render(info) {
    this._error.visible = false;
    const windows = normalizeMuseWindows(info);
    this._lastUsage = { windows };

    this._setTier(musePlanLabel(info));
    const parts = [info.user_full_name || info.user_email || "Meta"];
    if (info.is_subs_active === false) parts.push("inactive");
    this._subtitle.text = parts.join(" · ");

    this._renderWindows(windows);
    // The server omits the snapshot until the first request of a window
    // (the CLI's own explanation), so say so rather than show nothing.
    this._setExtra(windows.length ? [] : ["No usage reported yet for the current window."]);

    this.renderPanel();
    this.lastResult = "ok";
  }
}
