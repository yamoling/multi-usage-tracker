// Everything one usage source shows: its panel block (ring/bar, percentage,
// reset countdown, tier) and its popup section (logo, name, plan pill, one
// meter per usage window, an extra-info line, and an error line). The service
// specifics (how to fetch, how to fill the header) live in the subclasses
// under ui/views/. Instances are orchestrated by a UsageIndicator, which
// shares a single panel icon, poll timer, and countdown across its views.

import St from "gi://St";
import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import Gio from "gi://Gio";

import { UsageError, SignedOutError } from "../lib/errors.js";
import { LEVEL_RANK, maxLevel, levelClass, windowLevel, projectionNote, relativeReset, compactReset } from "../lib/format.js";
import { scheduleFraction, paceRgb, nextClockMark, paceThresholdsFromSettings } from "../lib/usagePace.js";
import { Meter, Ring, PanelBar, colorRgb, wrapLabel } from "./widgets.js";

export class UsageView {
  /**
   * @param {object} opts
   * @param {string} opts.name        Section title (and log label).
   * @param {string} opts.logoFile    Path of the popup logo.
   * @param {string} [opts.chip]      Short panel tag, or null for none.
   * @param {string} opts.logTag      Prefix for journal messages.
   * @param {string} [opts.pillClass] Style class(es) of the plan pill.
   * @param {object} [opts.messages]  Popup text for failures: {expired,
   *     forbidden, rateLimited, unreachable}. forbidden defers to the API's
   *     own wording when it has any.
   * @ai-edited
   */
  constructor({ name, logoFile, chip = null, logTag, pillClass = "cu-pill", messages = {} }, settings, panelBox, sectionsBox, isFirst) {
    this._settings = settings;
    this._displayName = name;
    this._logTag = logTag;
    this._messages = messages;
    this._lastUsage = null;
    // Outcome of this view's last refresh ('ok' | 'error' | 'signed-out'),
    // read by the indicator for the shared "Updated …" line.
    this.lastResult = null;
    // Normalised windows from the last render, cached for the panel
    // selector and the between-poll countdown.
    this._windows = [];
    this._meterBindings = [];
    // key (from the usage model) -> Meter, so meters are reused across
    // polls and torn down only when the API stops reporting that window.
    this._meters = new Map();

    // ---- panel block ----
    this._panelBlock = new St.BoxLayout({ style_class: "cu-panel-block" });
    this._panelSep = null;
    if (!isFirst) {
      this._panelSep = new St.Widget({ style_class: "cu-panel-sep", y_align: Clutter.ActorAlign.CENTER });
      panelBox.add_child(this._panelSep);
    }
    if (chip) {
      this._chip = new St.Label({
        text: chip,
        style_class: "cu-panel-chip",
        y_align: Clutter.ActorAlign.CENTER,
      });
      this._panelBlock.add_child(this._chip);
    }
    this._ring = new Ring();
    this._panelBar = new PanelBar();
    this._panelPct = new St.Label({ text: "…", style_class: "cu-panel-pct", y_align: Clutter.ActorAlign.CENTER });
    this._panelReset = new St.Label({ text: "", style_class: "cu-panel-reset", y_align: Clutter.ActorAlign.CENTER });
    this._panelTier = new St.Label({ text: "", style_class: "cu-panel-tier", y_align: Clutter.ActorAlign.CENTER });
    this._panelBlock.add_child(this._ring);
    this._panelBlock.add_child(this._panelBar.root);
    this._panelBlock.add_child(this._panelPct);
    this._panelBlock.add_child(this._panelReset);
    this._panelBlock.add_child(this._panelTier);
    panelBox.add_child(this._panelBlock);

    // ---- popup section ----
    this._section = new St.BoxLayout({
      vertical: true,
      style_class: isFirst ? "cu-profile-section" : "cu-profile-section cu-profile-section-divider",
    });

    // Each view carries its own logo and name, so the popup reads as a
    // list of accounts rather than one branded header over anonymous rows.
    const header = new St.BoxLayout({ style_class: "cu-profile-header" });
    this._logo = new St.Icon({
      gicon: Gio.icon_new_for_string(logoFile),
      style_class: "cu-logo",
      y_align: Clutter.ActorAlign.CENTER,
    });
    header.add_child(this._logo);
    const who = new St.BoxLayout({ vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER });
    this._label = new St.Label({ text: name, style_class: "cu-title" });
    this._subtitle = new St.Label({ text: "", style_class: "cu-subtitle" });
    who.add_child(this._label);
    who.add_child(this._subtitle);
    this._pill = new St.Label({ text: "", style_class: pillClass, y_align: Clutter.ActorAlign.CENTER });
    // An empty pill still paints as a coloured dot; only show it with a tier.
    this._pill.visible = false;
    header.add_child(who);
    header.add_child(this._pill);
    this._section.add_child(header);

    // Limits — one meter per window the API reports, built on render.
    this._metersBox = new St.BoxLayout({ vertical: true });
    this._section.add_child(this._metersBox);

    this._extra = wrapLabel(new St.Label({ text: "", style_class: "cu-extra" }));
    this._extra.visible = false;
    this._section.add_child(this._extra);

    this._error = wrapLabel(new St.Label({ text: "", style_class: "cu-error" }));
    this._error.visible = false;
    this._section.add_child(this._error);

    sectionsBox.add_child(this._section);
  }

  applyVisibility() {
    const gauge = this._settings.get_string("panel-gauge");
    this._ring.visible = gauge === "ring";
    this._panelBar.root.visible = gauge === "bar";
    this._panelPct.visible = this._settings.get_boolean("show-percentage");
    this._panelTier.visible = this._settings.get_boolean("show-tier");
    this._panelReset.visible = this._settings.get_boolean("show-reset");
    // The chip is only built with more than one profile, and is then
    // toggleable — some people would rather not spend the panel width.
    if (this._chip) this._chip.visible = this._settings.get_boolean("show-profile-chip");
  }

  // Fills the plan pill in the popup and the short tier label in the panel.
  _setTier(label) {
    this._pill.text = label;
    this._pill.visible = true;
    this._panelTier.text = label.split(" ")[0];
  }

  // Shows extra info lines under the meters (hidden when empty), optionally
  // coloured by a severity level.
  _setExtra(lines, level = null) {
    this._extra.text = lines.join("\n");
    this._extra.style_class = level ? `cu-extra ${levelClass(level)}` : "cu-extra";
    this._extra.visible = lines.length > 0;
  }

  // Instant, network-free tier from local credentials. Optional per service.
  async applyTierFromDisk(_cancellable) {}

  // Fetches and renders this view; must never reject (errors are rendered in
  // the section). The indicator drives concurrency across views.
  async refresh(_cancellable) {}

  // Builds (or reuses) one meter per normalised window, in window order.
  _renderWindows(windows) {
    this._windows = windows;
    this._meterBindings = [];
    const seen = new Set();
    for (const w of this._windows) {
      seen.add(w.key);
      let meter = this._meters.get(w.key);
      if (!meter) {
        meter = new Meter(w.label);
        this._metersBox.add_child(meter.root);
        this._meters.set(w.key, meter);
      } else {
        meter.setName(w.label);
      }
      this._bindWindow(meter, w);
    }
    // Keep the on-screen order matching the window order.
    this._windows.forEach((w, i) => {
      this._metersBox.set_child_at_index(this._meters.get(w.key).root, i);
    });
    // Drop meters for windows the API stopped reporting.
    for (const [key, meter] of this._meters) {
      if (!seen.has(key)) {
        meter.destroy();
        this._meters.delete(key);
      }
    }
  }

  // Pairs a meter with its normalised window so the live countdown can
  // re-render the caption between polls without another network round-trip.
  _bindWindow(meter, w) {
    this._meterBindings.push({ meter, w });
    this._applyWindow(meter, w);
  }

  // Soonest reset among this view's on-screen windows, in seconds, or null.
  soonestResetSeconds() {
    let soonest = null;
    for (const { w } of this._meterBindings) {
      if (!w?.resetsAt) continue;
      const t = Date.parse(w.resetsAt);
      if (Number.isNaN(t)) continue;
      const rem = (t - Date.now()) / 1000;
      if (rem > 0 && (soonest === null || rem < soonest)) soonest = rem;
    }
    return soonest;
  }

  // Re-apply meters and panel from the last fetched usage (captions only move).
  refreshCountdowns() {
    if (!this._lastUsage) return;
    for (const { meter, w } of this._meterBindings) this._applyWindow(meter, w);
    this.renderPanel();
  }

  // Gauge colour compares usage to the schedule marker; fill remains actual usage.
  /** @ai-edited */
  _applyWindow(meter, w) {
    if (!w || !Number.isFinite(w.utilization)) {
      meter.setMuted();
      return;
    }
    const util = w.utilization;

    let caption = w.resetsAt ? relativeReset(w.resetsAt) : util > 0 ? "" : "not used yet";

    const note = projectionNote(util, w.resetsAt, w.totalSeconds);
    if (note) caption = caption ? `${caption} · ${note}` : note;

    const mark = this._settings.get_boolean("show-clock-mark") ? nextClockMark(w.resetsAt, w.totalSeconds) : null;
    meter.setValue(util, caption, this._windowRgb(w), scheduleFraction(w.resetsAt, w.totalSeconds), mark);
  }

  // Final level for a normalised window: the computed burn consequence,
  // floored at the API's severity.
  _windowLevel(w) {
    return maxLevel(windowLevel(w.utilization, w.resetsAt, w.totalSeconds), w.apiLevel);
  }

  // Shared pace gradient, with a neutral theme colour when timing is missing.
  /** @ai-edited */
  _windowRgb(w) {
    const thresholds = paceThresholdsFromSettings(this._settings);
    return (
      paceRgb(w.utilization, w.resetsAt, w.totalSeconds, Date.now(), thresholds) ??
      colorRgb(this._ring.get_theme_node().get_foreground_color())
    );
  }

  // The worst window to surface in the panel: the highest severity among the
  // active limits (or all of them if none are marked active), breaking ties by
  // utilization. This is how a 100% scoped window (e.g. Fable) reaches the bar
  // even when the session and weekly totals are calm.
  _worstWindow(windows) {
    const active = windows.filter((w) => w.isActive);
    const pool = active.length ? active : windows;
    const score = (w) => LEVEL_RANK[this._windowLevel(w)] * 1000 + (Number(w.utilization) || 0);
    return pool.reduce((best, w) => (score(w) > score(best) ? w : best));
  }

  // Which normalised usage window the panel reflects, per the panel-window
  // preference. A service without the requested window (e.g. Vibe's single
  // monthly allowance) falls back to its first window.
  _panelWindow() {
    const windows = this._windows;
    if (!windows || !windows.length) return null;
    switch (this._settings.get_string("panel-window")) {
      case "seven-day":
        return windows.find((w) => w.role === "weekly") ?? windows[0];
      case "worst":
        return this._worstWindow(windows);
      case "max":
        return windows.reduce((best, w) => ((Number(w.utilization) || 0) > (Number(best.utilization) || 0) ? w : best));
      case "five-hour":
      default:
        return windows.find((w) => w.role === "session") ?? windows[0];
    }
  }

  /** @ai-edited */
  renderPanel() {
    const sel = this._panelWindow();
    if (!sel || !Number.isFinite(sel.utilization)) {
      this._panelPct.text = "—";
      this._panelPct.style_class = "cu-panel-pct";
      this._ring.setUnknown();
      this._panelBar.setUnknown();
      this._panelReset.text = "";
      return;
    }
    const util = sel.utilization;
    const level = this._windowLevel(sel);
    this._panelPct.text = `${Math.round(util)}%`;
    this._panelPct.style_class = `cu-panel-pct ${levelClass(level)}`;
    this._panelReset.text = sel.resetsAt ? compactReset(sel.resetsAt) : "";
    const rgb = this._windowRgb(sel);
    this._ring.setValue(util, rgb);
    this._panelBar.setValue(util, rgb);
  }

  /**
   * Popup text for a failed refresh, from the service's `messages`.
   * @ai-edited
   */
  _errorMessage(e) {
    const m = this._messages;
    if (e instanceof UsageError) {
      if (e.status === 401 && m.expired) return m.expired;
      if (e.status === 403) return e.apiMessage() || m.forbidden || e.message;
      if (e.status === 429 && m.rateLimited) return m.rateLimited;
    }
    return e.message || m.unreachable || "Could not reach the usage service";
  }

  _renderError(e) {
    // A cancelled request means the extension is being torn down (or
    // views are being rebuilt); nothing to show.
    if (e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) return;
    // No login to use: a state, not a failure.
    if (e instanceof SignedOutError) {
      this._renderSignedOut(e);
      return;
    }
    // A 429 is transient (we polled a touch too soon). If we already have
    // usage on screen, keep showing it instead of flashing an error.
    if (e instanceof UsageError && e.status === 429 && this._lastUsage) {
      logError(e, `${this._logTag}: rate limited for "${this._displayName}", keeping last data`);
      return;
    }
    this._panelPct.text = "!";
    this._panelPct.style_class = "cu-panel-pct cu-warn";
    this._ring.setUnknown();
    this._panelBar.setUnknown();
    this._panelReset.text = "";
    this._error.text = this._errorMessage(e);
    this._error.style_class = "cu-error";
    this._error.visible = true;
    this.lastResult = "error";
    logError(e, `${this._logTag}: refresh failed for "${this._displayName}"`);
  }

  // Clear any stale usage and show a muted "signed out" line.
  _renderSignedOut(e) {
    for (const meter of this._meters.values()) meter.destroy();
    this._meters.clear();
    this._meterBindings = [];
    this._windows = [];
    this._lastUsage = null;

    this._subtitle.text = "Signed out";
    this._pill.text = "";
    this._pill.visible = false;
    this._panelTier.text = "";
    this._extra.visible = false;

    this._panelPct.text = "—";
    this._panelPct.style_class = "cu-panel-pct";
    this._ring.setUnknown();
    this._panelBar.setUnknown();
    this._panelReset.text = "";

    this._error.text = e.message;
    this._error.style_class = "cu-error cu-dim";
    this._error.visible = true;
    // Not a failure: the subtitle and note already say "signed out".
    this.lastResult = "signed-out";
  }

  // Destroys every widget this view owns, leaf-first, then releases the
  // references. The children would go with their containers anyway, but the
  // store's review tooling matches each `this._x = new St.…` against a
  // corresponding `this._x.destroy()` and cannot infer cascading, so each one
  // is destroyed explicitly.
  destroy() {
    for (const meter of this._meters.values()) meter.destroy();
    this._meters.clear();

    // Panel block contents, then the block itself.
    this._ring?.destroy();
    this._panelBar?.destroy();
    this._chip?.destroy();
    this._panelPct?.destroy();
    this._panelReset?.destroy();
    this._panelTier?.destroy();
    this._panelSep?.destroy();
    this._panelBlock?.destroy();

    // Popup section contents, then the section itself.
    this._logo?.destroy();
    this._label?.destroy();
    this._subtitle?.destroy();
    this._pill?.destroy();
    this._extra?.destroy();
    this._error?.destroy();
    this._metersBox?.destroy();
    this._section?.destroy();

    this._ring = null;
    this._panelBar = null;
    this._chip = null;
    this._panelPct = null;
    this._panelReset = null;
    this._panelTier = null;
    this._panelSep = null;
    this._panelBlock = null;
    this._logo = null;
    this._label = null;
    this._subtitle = null;
    this._pill = null;
    this._extra = null;
    this._error = null;
    this._metersBox = null;
    this._section = null;
    this._meterBindings = [];
    this._windows = [];
    this._lastUsage = null;
    this._client = null;
  }
}
