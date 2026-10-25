// One Claude Code profile (one config directory / one account).

import { UsageClient } from "../../lib/usageClient.js";
import { normalizeWindows, normalizeSpend } from "../../lib/usageModel.js";
import { UsageView } from "../usageView.js";

// Plan label for the pill: the API's raw token (`subscriptionType` from disk or
// `organization_type` from the profile), prefix-stripped and cased — nothing
// mapped by name, so new plans show through. "CLAUDE" only if the API said
// nothing. A multiplier in the rate-limit tier ("…_20x") is appended.
function tierLabel(plan, rateLimitTier) {
  const base =
    String(plan ?? "")
      .replace(/^claude[_-]/i, "")
      .replace(/[_-]+/g, " ")
      .trim()
      .toUpperCase() || "CLAUDE";
  const m = /(\d+)x/.exec(rateLimitTier ?? "");
  return m ? `${base} ${m[1]}x` : base;
}

// Short (1-2 letter) chip for a profile label, so the panel can distinguish
// multiple profiles without much width: "TechZu" -> "TE", "My Team" -> "MT".
function profileChip(label) {
  const words = (label ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return (label ?? "").slice(0, 2).toUpperCase() || "?";
}

export class ProfileView extends UsageView {
  constructor(profile, settings, panelBox, sectionsBox, showChip, isFirst, allowSharedToken, path) {
    super(
      {
        name: profile.label,
        logoFile: `${path}/icons/octopus.png`,
        chip: showChip ? profileChip(profile.label) : null,
        logTag: "claude-usage",
        messages: {
          expired: "Session expired. Sign in via Claude Code or Settings.",
          // The API refuses to serve usage for this account: typically no
          // active subscription, even though auth itself succeeded (so the
          // profile fetch can still show a stale plan/tier).
          forbidden: "No active Claude subscription for this account.",
          rateLimited: "Rate limited by Claude; will retry shortly.",
          unreachable: "Could not reach Claude",
        },
      },
      settings,
      panelBox,
      sectionsBox,
      isFirst,
    );
    this.profile = profile;
    this._client = new UsageClient({ configDir: profile.configDir, settings, allowSharedToken, profileId: profile.id });
  }

  async applyTierFromDisk(cancellable) {
    try {
      const { subscriptionType, rateLimitTier } = await this._client.tierFromDisk();
      if (cancellable.is_cancelled()) return;
      // No credentials on disk: leave the tier blank rather than flash a
      // generic "CLAUDE"; the refresh fills in the real state shortly.
      if (!subscriptionType && !rateLimitTier) return;
      this._setTier(tierLabel(subscriptionType, rateLimitTier));
    } catch {
      // Not signed in yet; the refresh will surface a clearer message.
    }
  }

  // Fetches usage + profile for this account only; never rejects (errors are
  // reported through renderError). Caller drives concurrency across profiles.
  async refresh(cancellable) {
    const [usageRes, profileRes] = await Promise.allSettled([this._client.fetchUsage(cancellable), this._client.fetchProfile(cancellable)]);
    if (cancellable.is_cancelled()) return;
    if (usageRes.status === "rejected") {
      this._renderError(usageRes.reason);
      return;
    }
    if (profileRes.status === "rejected")
      logError(profileRes.reason, `claude-usage: profile fetch failed for "${this.profile.label}" (non-fatal)`);
    this._render(usageRes.value, profileRes.status === "fulfilled" ? profileRes.value : null);
  }

  _render(usage, profile) {
    this._error.visible = false;
    this._lastUsage = usage;

    if (profile?.account) {
      const sub = profile.application?.name ?? "Claude";
      const status = profile.organization?.subscription_status === "active" ? `${sub} · active` : sub;
      // The section title is the profile's own label, so fold the account
      // identity into the subtitle instead of dropping it — otherwise a
      // single-profile user loses the display name the header used to
      // show, and it stays useful for telling profiles apart.
      const who = profile.account.display_name || profile.account.full_name || "";
      this._subtitle.text = who ? `${who} · ${status}` : status;
      // Org plan is authoritative and always present; the has_claude_*
      // booleans are only a fallback (both false for team/enterprise seats).
      const plan =
        profile.organization?.organization_type ?? (profile.account.has_claude_max ? "max" : profile.account.has_claude_pro ? "pro" : null);
      this._setTier(tierLabel(plan, profile.organization?.rate_limit_tier));
    }

    // Build the meter list from the normalised windows. The model prefers
    // the API's self-describing limits[] array (which now carries per-model
    // windows like Fable) and falls back to the legacy flat keys.
    this._renderWindows(normalizeWindows(usage));
    this._renderSpend(usage);

    this.renderPanel();
    this.lastResult = "ok";
  }

  // Renders the "extra usage" line from the normalised spend block (the new
  // structured `spend` object, or the legacy `extra_usage` fallback), colour-
  // ing it by the API's severity.
  _renderSpend(usage) {
    const spend = normalizeSpend(usage);
    if (!spend) {
      this._setExtra([]);
      return;
    }
    const parts = [spend.used, spend.limit].filter(Boolean);
    let text = `Extra usage: ${parts.join(" / ")}`;
    if (spend.percent !== null) text += ` (${spend.percent}%)`;
    this._setExtra([text], spend.level);
  }
}
