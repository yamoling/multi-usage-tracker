// One panel button with its own popup, poll timer, and countdown, showing one
// or more UsageViews side by side. The extension creates one per service
// (see lib/services.js), so each gets its own indicator in the top bar.

import GObject from "gi://GObject";
import St from "gi://St";
import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import Gio from "gi://Gio";

import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

import { PACE_THRESHOLD_KEYS } from "../lib/usagePace.js";

// Collapse refreshes that land closer together than this. Opening the popup
// triggers a refresh, and so does the poll timer; without a floor the two can
// fire back-to-back and the second request is rate-limited (429) by the API.
const MIN_REFRESH_MS = 60 * 1000;

export const UsageIndicator = GObject.registerClass(
  class UsageIndicator extends PanelMenu.Button {
    /**
     * @param {string} name  Accessible name of the panel button.
     * @param {object} opts  {path, settings, openPreferences, iconFile,
     *     usageUrl, buildViews?, watchKeys?}. buildViews(indicator) returns
     *     the views to show; when given, they are built straight away.
     *     watchKeys are extra GSettings keys whose change forces a refetch
     *     (e.g. a stored session for the service).
     * @ai-edited
     */
    _init(name, { path, settings, openPreferences, iconFile, usageUrl, buildViews = null, watchKeys = [] }) {
      super._init(0.5, name);

      this._path = path;
      this._settings = settings;
      this._openPreferences = openPreferences;
      this._busy = false;
      this._cancellable = new Gio.Cancellable();
      this._lastFetchMs = 0;
      this._views = [];
      // Cancelled whenever the views are replaced, so a refresh still in
      // flight for the old views neither renders into destroyed widgets nor
      // blocks the first refresh of the new ones.
      this._viewsCancellable = null;
      this._countdownTimer = null;
      this._timer = null;

      // ---- panel button ----
      this._panelBox = new St.BoxLayout({ style_class: "cu-panel" });
      this._panelIcon = new St.Icon({
        gicon: Gio.icon_new_for_string(iconFile),
        style_class: "cu-panel-icon",
        y_align: Clutter.ActorAlign.CENTER,
      });
      this._panelBox.add_child(this._panelIcon);
      // View blocks are appended after the icon by _setViews().
      this.add_child(this._panelBox);

      this._buildMenuShell(usageUrl);

      // connectObject ties these handlers to `this`, so a single
      // disconnectObject(this) in destroy() (and the automatic cleanup when
      // this actor is destroyed) tears them all down.
      this.menu.connectObject(
        "open-state-changed",
        (_m, open) => {
          if (open) this._refresh();
        },
        this,
      );

      // Live-apply preference changes without needing a shell reload.
      this._settings.connectObject(
        "changed::show-icon",
        () => this._applyVisibility(),
        "changed::panel-gauge",
        () => this._applyVisibility(),
        "changed::show-percentage",
        () => this._applyVisibility(),
        "changed::show-tier",
        () => this._applyVisibility(),
        "changed::show-reset",
        () => this._applyVisibility(),
        "changed::show-profile-chip",
        () => this._applyVisibility(),
        "changed::panel-window",
        () => this._renderAllPanels(),
        "changed::show-clock-mark",
        () => this._views.forEach((view) => view.refreshCountdowns()),
        "changed::poll-seconds",
        () => this._startTimer(),
        ...Object.values(PACE_THRESHOLD_KEYS).flatMap((key) => [
          `changed::${key}`,
          () => this._views.forEach((view) => view.refreshCountdowns()),
        ]),
        ...watchKeys.flatMap((key) => [`changed::${key}`, () => this._refresh(true)]),
        this,
      );

      this._applyVisibility();
      if (buildViews) this._setViews(() => buildViews(this));
    }

    // Containers the views attach their panel block and popup section to.
    get panelBox() {
      return this._panelBox;
    }

    get sectionsBox() {
      return this._sectionsBox;
    }

    /**
     * Replaces the views with build()'s, then fetches them all right away.
     * @ai-edited
     */
    _setViews(build) {
      this._destroyViews();
      this._viewsCancellable = new Gio.Cancellable();
      this._views = build();
      this._applyVisibility();
      for (const view of this._views) view.applyTierFromDisk(this._viewsCancellable);
      this._refresh(true);
      this._startTimer();
    }

    /** @ai-edited */
    _destroyViews() {
      this._viewsCancellable?.cancel();
      this._viewsCancellable = null;
      // The cancelled refresh (if any) no longer counts as in flight.
      this._busy = false;
      if (this._countdownTimer) {
        GLib.source_remove(this._countdownTimer);
        this._countdownTimer = null;
      }
      for (const view of this._views) view.destroy();
      this._views = [];
    }

    _buildMenuShell(usageUrl) {
      const item = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
      const root = new St.BoxLayout({ vertical: true, style_class: "cu-popup" });
      item.add_child(root);
      this.menu.addMenuItem(item);

      // No global header: each view's section carries its own logo and name.
      this._sectionsBox = new St.BoxLayout({ vertical: true });
      root.add_child(this._sectionsBox);

      // actions
      const actions = new St.BoxLayout({ style_class: "cu-actions" });
      const openUsage = new St.Button({ label: "Usage page", style_class: "cu-btn cu-btn-pri", x_expand: true });
      openUsage.connect("clicked", () => {
        this.menu.close();
        Gio.AppInfo.launch_default_for_uri(usageUrl, null);
      });
      actions.add_child(openUsage);
      root.add_child(actions);

      // footer
      const footer = new St.BoxLayout({ style_class: "cu-footer" });
      // One timestamp for the whole popup: every view refreshes in the same
      // cycle, so a per-view time would just repeat itself.
      this._updated = new St.Label({ text: "Loading…", style_class: "cu-updated", x_expand: true });
      footer.add_child(this._updated);
      const settingsBtn = new St.Button({ label: "⚙ Settings", style_class: "cu-refresh", x_expand: true });
      settingsBtn.connect("clicked", () => {
        this.menu.close();
        this._openPreferences?.();
      });
      this._refreshBtn = new St.Button({ label: "↻ Refresh", style_class: "cu-refresh", x_expand: true });
      // connectObject so destroy() can drop this with disconnectObject(this);
      // a bare connect() on a this._* field is flagged by the store's review
      // tooling as a signal that is never disconnected.
      this._refreshBtn.connectObject("clicked", () => this._refresh(true), this);
      footer.add_child(settingsBtn);
      footer.add_child(this._refreshBtn);
      root.add_child(footer);
    }

    _startTimer() {
      if (this._timer) {
        GLib.source_remove(this._timer);
        this._timer = null;
      }
      const seconds = this._settings.get_int("poll-seconds");
      this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
        this._refresh();
        return GLib.SOURCE_CONTINUE;
      });
    }

    // One shared timestamp for the whole popup. Every view refreshes in the
    // same cycle, so this reports the cycle: the time when at least one view
    // updated, "Update failed" when every view that could have fetched
    // failed, and nothing at all when they are simply all signed out.
    _renderUpdatedAt() {
      if (!this._updated) return;
      const results = this._views.map((v) => v.lastResult);
      if (results.includes("ok")) {
        const now = GLib.DateTime.new_now_local();
        this._updated.text = `Updated ${now.format("%H:%M:%S")}`;
      } else if (results.includes("error")) {
        this._updated.text = "Update failed";
      } else {
        this._updated.text = "";
      }
    }

    _applyVisibility() {
      this._panelIcon.visible = this._settings.get_boolean("show-icon");
      for (const view of this._views) view.applyVisibility();
      if (this._refreshBtn) this._refreshBtn.label = this._views.length > 1 ? "↻ Refresh all" : "↻ Refresh";
    }

    _renderAllPanels() {
      for (const view of this._views) view.renderPanel();
    }

    // force bypasses the min-gap throttle (used for explicit user actions like
    // signing in or editing profiles); opening the popup and the poll timer go
    // through the throttle. All views are fetched concurrently.
    /** @ai-edited */
    _refresh(force = false) {
      if (this._busy || this._views.length === 0) return;
      if (!force && Date.now() - this._lastFetchMs < MIN_REFRESH_MS) return;
      this._busy = true;
      this._lastFetchMs = Date.now();

      const cancellable = this._viewsCancellable;
      Promise.allSettled(this._views.map((view) => view.refresh(cancellable))).finally(() => {
        // A cancelled cycle belongs to views that are gone; _destroyViews
        // already cleared the busy flag for the new ones.
        if (cancellable.is_cancelled()) return;
        this._busy = false;
        this._renderUpdatedAt();
        this._scheduleCountdown();
      });
    }

    // Soonest reset across every window of every view, in seconds, or null.
    _soonestResetSeconds() {
      let soonest = null;
      for (const view of this._views) {
        const rem = view.soonestResetSeconds();
        if (rem !== null && (soonest === null || rem < soonest)) soonest = rem;
      }
      return soonest;
    }

    // Tick the "resets in …" captions between polls: every second once a reset
    // is under 90s away (so the seconds display is live), every 30s otherwise.
    _scheduleCountdown() {
      if (this._countdownTimer) {
        GLib.source_remove(this._countdownTimer);
        this._countdownTimer = null;
      }
      const soonest = this._soonestResetSeconds();
      if (soonest === null) return;
      const interval = soonest < 90 ? 1 : 30;
      this._countdownTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, interval, () => {
        this._countdownTimer = null;
        for (const view of this._views) view.refreshCountdowns();
        this._scheduleCountdown();
        return GLib.SOURCE_REMOVE;
      });
    }

    destroy() {
      // Abort any in-flight fetch so its callback drops out (it checks the
      // cancellable) instead of touching torn-down actors.
      this._cancellable?.cancel();
      this._cancellable = null;
      if (this._timer) {
        GLib.source_remove(this._timer);
        this._timer = null;
      }
      if (this._countdownTimer) {
        GLib.source_remove(this._countdownTimer);
        this._countdownTimer = null;
      }
      this.menu.disconnectObject(this);
      this._settings.disconnectObject(this);
      this._settings = null;

      this._updated?.destroy();
      this._updated = null;
      this._refreshBtn?.disconnectObject(this);
      this._refreshBtn?.destroy();
      this._refreshBtn = null;
      this._panelIcon?.destroy();
      this._panelIcon = null;

      this._destroyViews();

      // Destroyed after the views, which live inside these boxes.
      this._panelBox?.destroy();
      this._panelBox = null;
      this._sectionsBox?.destroy();
      this._sectionsBox = null;

      super.destroy();
    }
  },
);
