import GObject from "gi://GObject";
import St from "gi://St";
import Clutter from "gi://Clutter";
import GLib from "gi://GLib";
import Gio from "gi://Gio";
import Pango from "gi://Pango";
import Meta from "gi://Meta";
import Shell from "gi://Shell";
import Cairo from "cairo";

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import * as PanelMenu from "resource:///org/gnome/shell/ui/panelMenu.js";
import * as PopupMenu from "resource:///org/gnome/shell/ui/popupMenu.js";

import { UsageClient, UsageError, SignedOutError, defaultConfigDir } from "./lib/usageClient.js";
import { loadProfiles, ensureProfiles } from "./lib/profiles.js";
import { normalizeWindows, normalizeSpend } from "./lib/usageModel.js";
import { scheduleFraction, paceRgb, nextClockMark, paceThresholdsFromSettings, PACE_THRESHOLD_KEYS } from "./lib/usagePace.js";
import { CodexClient } from "./lib/codexClient.js";
import { normalizeCodexWindows, normalizeResetCredits, codexCredits, codexPlanLabel } from "./lib/codexModel.js";

const CLAUDE_USAGE_URL = "https://claude.ai/settings/usage";
const CODEX_USAGE_URL = "https://chatgpt.com/codex/settings/usage";

// Severity levels, least to most severe.
const LEVEL_RANK = { ok: 0, warn: 1, crit: 2 };

// Severity from a raw utilization %: how full the bucket is right now.
function utilLevel(util) {
  if (util >= 90) return "crit";
  if (util >= 75) return "warn";
  return "ok";
}

// The more severe of two levels.
function maxLevel(a, b) {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

// Style-class suffix for a level (cu-ok / cu-warn / cu-crit).
function levelClass(level) {
  return `cu-${level}`;
}

// Colour ramp for the usage gauges, as [heat, [r, g, b]] stops. The old
// three level colours sit at their thresholds (amber at 75%, red at 90%), with
// yellow before amber, so a gauge shifts gradually as it fills instead of
// jumping between three colours.
const HEAT_STOPS = [
  [0.0, [0.2, 0.82, 0.48]], // #33d17a green
  [0.6, [0.96, 0.83, 0.18]], // #f6d32d yellow
  [0.75, [1.0, 0.47, 0.0]], // #ff7800 amber
  [0.9, [0.88, 0.11, 0.14]], // #e01b24 red
];

// RGB float triple for a heat in [0, 1], interpolated between the stops.
function heatRgb(heat) {
  const h = Math.max(0, Math.min(1, Number(heat) || 0));
  for (let i = 1; i < HEAT_STOPS.length; i++) {
    const [p1, c1] = HEAT_STOPS[i];
    if (h <= p1) {
      const [p0, c0] = HEAT_STOPS[i - 1];
      const t = (h - p0) / (p1 - p0);
      return c0.map((v, k) => v + (c1[k] - v) * t);
    }
  }
  return HEAT_STOPS[HEAT_STOPS.length - 1][1];
}

// CSS colour for an RGB float triple, for St widgets.
function rgbCss([r, g, b]) {
  const byte = (v) => Math.round(v * 255);
  return `rgb(${byte(r)}, ${byte(g)}, ${byte(b)})`;
}

const RING_SIZE = 18;
const RING_WIDTH = 3;
const PANEL_BAR_WIDTH = 34;
// Width of the dent cut into a popup bar at the next 08:00/18:00.
const BAR_DENT_WIDTH = 2;
const BAR_TRACK_RGBA = [0.5, 0.5, 0.5, 0.3];

// StThemeNode colors are Cogl.Color. Across GNOME Shell versions the
// components come back either as 0-255 bytes or as 0-1 floats depending on
// the GJS build, so detect the scale instead of assuming one. Returns an
// [r, g, b] float triple.
function colorRgb(c) {
  const scale = Math.max(c.red, c.green, c.blue) > 1 ? 255 : 1;
  return [c.red / scale, c.green / scale, c.blue / scale];
}

// Collapse refreshes that land closer together than this. Opening the popup
// triggers a refresh, and so does the poll timer; without a floor the two can
// fire back-to-back and the second request is rate-limited (429) by the API.
const MIN_REFRESH_MS = 60 * 1000;

// Projected end-of-window utilization at the current consumption rate. Returns
// the larger of actual and projected, falling back to actual when the window
// has barely started (too little signal) or reports no reset time.
function projectedUtil(util, resetsAtIso, totalSeconds) {
  const target = Date.parse(resetsAtIso ?? "");
  if (Number.isNaN(target) || !totalSeconds) return util;
  const remaining = (target - Date.now()) / 1000;
  if (remaining <= 0) return util;
  const elapsed = totalSeconds - remaining;
  if (elapsed <= 0 || elapsed / totalSeconds < 0.05) return util;
  return Math.max(util, (util * totalSeconds) / elapsed);
}

// Seconds from now until utilization would hit 100% at the average rate so far
// this window, but only when that exhaustion lands before the window resets
// (i.e. the current pace really does overrun the limit). Returns null
// otherwise, using the same early-window guard as projectedUtil so we don't
// extrapolate from noise.
function exhaustSeconds(util, resetsAtIso, totalSeconds) {
  const target = Date.parse(resetsAtIso ?? "");
  if (Number.isNaN(target) || !totalSeconds || util <= 0) return null;
  const remaining = (target - Date.now()) / 1000;
  if (remaining <= 0) return null;
  const elapsed = totalSeconds - remaining;
  if (elapsed <= 0 || elapsed / totalSeconds < 0.05) return null;
  const toExhaust = (elapsed * (100 - util)) / util;
  return toExhaust > 0 && toExhaust < remaining ? toExhaust : null;
}

// Human-friendly duration trimmed to the two largest units: "30s", "45m",
// "4h 21m", "2d 5h". sep sets what goes between the two units, e.g. '' for the
// compact panel form ("4h21m").
function humanDuration(seconds, sep = " ") {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h${sep}${mins % 60}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d${sep}${hrs % 24}h`;
}

// Being locked out for at least this fraction of the window makes a fast burn
// "critical" (red). A shorter lockout (running out just before the reset) only
// warrants a warning (amber).
const LOCKOUT_CRIT_FRAC = 0.1;

// How long you'd be stuck at the limit before the window resets, in seconds, at
// the current burn rate, or null when the pace doesn't run out before reset.
function lockoutSeconds(util, resetsAtIso, totalSeconds) {
  const exhaust = exhaustSeconds(util, resetsAtIso, totalSeconds);
  if (exhaust === null) return null;
  const remaining = (Date.parse(resetsAtIso) - Date.now()) / 1000;
  return Math.max(0, remaining - exhaust);
}

// Severity for a usage window, based on the *consequence* of the current burn
// rather than the raw projected percentage. Red is reserved for "out of
// headroom now, or locked out for a meaningful stretch"; a burn that only just
// overruns right before the reset stays amber.
function windowLevel(util, resetsAtIso, totalSeconds) {
  // Floor: how full the bucket is right now, independent of timing.
  let level = utilLevel(util);

  const lockout = lockoutSeconds(util, resetsAtIso, totalSeconds);
  if (lockout !== null) {
    // Projected to run out before the reset: escalate by how long you'd be
    // locked out, as a fraction of the whole window.
    const projLevel = lockout >= totalSeconds * LOCKOUT_CRIT_FRAC ? "crit" : "warn";
    level = maxLevel(level, projLevel);
  } else {
    // Won't run out before the reset: a rising window can warn, but never
    // go critical from projection alone.
    if (projectedUtil(util, resetsAtIso, totalSeconds) >= 75) level = maxLevel(level, "warn");
  }
  return level;
}

// Caption note explaining the projection, tied to the same lockout threshold as
// windowLevel so an amber gauge never reads "burning fast".
function projectionNote(util, resetsAtIso, totalSeconds) {
  const lockout = lockoutSeconds(util, resetsAtIso, totalSeconds);
  if (lockout !== null) {
    if (lockout >= totalSeconds * LOCKOUT_CRIT_FRAC) {
      const exhaust = exhaustSeconds(util, resetsAtIso, totalSeconds);
      return `burning fast — out in ~${humanDuration(exhaust)} at this rate`;
    }
    return "on pace to run out just before reset";
  }
  const proj = projectedUtil(util, resetsAtIso, totalSeconds);
  if (proj >= 75 && Math.round(proj) > Math.round(util)) return `on track for ~${Math.round(proj)}% by reset`;
  return "";
}

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

function relativeReset(iso) {
  const target = Date.parse(iso);
  if (Number.isNaN(target)) return "";
  const diff = target - Date.now();
  if (diff <= 0) return "resetting…";
  if (diff < 60000) return `resets in ${Math.floor(diff / 1000)}s`;
  const mins = Math.round(diff / 60000);
  if (mins < 60) return `resets in ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `resets in ${hrs}h ${mins % 60}m`;
  const days = Math.floor(hrs / 24);
  return `resets in ${days}d ${hrs % 24}h`;
}

// Compact "time until reset" for the panel: magnitude only, no "resets in"
// prefix, no separator between units ("4h21m"). Empty when the timestamp is
// missing or unparseable so the label collapses instead of showing junk.
function compactReset(iso) {
  const target = Date.parse(iso);
  if (Number.isNaN(target)) return "";
  const diff = target - Date.now();
  if (diff <= 0) return "now";
  return humanDuration(diff / 1000, "");
}

// Let a fixed-width popup label wrap onto extra lines instead of running off
// the edge. Pango only wraps when the text actually exceeds the width, so short
// text stays on one line. Returns the label for chaining.
function wrapLabel(label) {
  label.x_expand = true;
  label.clutter_text.line_wrap = true;
  label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
  label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
  return label;
}

// The popup meter's bar, drawn with Cairo so the clock-mark dent is a real
// transparent gap in both the track and the fill.
const UsageBar = GObject.registerClass(
  class UsageBar extends St.DrawingArea {
    _init() {
      super._init({ style_class: "cu-bar" });
      this._fraction = 0;
      this._rgb = null;
      this._dent = null;
    }

    setState(fraction, rgb, dent) {
      this._fraction = fraction;
      this._rgb = rgb;
      this._dent = dent;
      this.queue_repaint();
    }

    /** @ai-generated */
    vfunc_repaint() {
      const cr = this.get_context();
      const [w, h] = this.get_surface_size();
      const pill = (x0, x1) => {
        const r = Math.min(h / 2, (x1 - x0) / 2);
        if (r <= 0) return;
        cr.newSubPath();
        cr.arc(x0 + r, h / 2, r, Math.PI / 2, (3 * Math.PI) / 2);
        cr.arc(x1 - r, h / 2, r, -Math.PI / 2, Math.PI / 2);
        cr.closePath();
      };

      pill(0, w);
      cr.clip();
      cr.setSourceRGBA(...BAR_TRACK_RGBA);
      cr.paint();

      const fw = this._fraction * w;
      if (fw > 0 && this._rgb) {
        cr.setSourceRGBA(...this._rgb, 1);
        pill(0, fw);
        cr.fill();
      }

      if (this._dent !== null) {
        cr.resetClip();
        cr.setOperator(Cairo.Operator.CLEAR);
        cr.rectangle(Math.round(this._dent * w - BAR_DENT_WIDTH / 2), 0, BAR_DENT_WIDTH, h);
        cr.fill();
      }

      cr.$dispose();
    }
  },
);

// A labelled progress meter: title + percentage row, bar, and reset caption.
class Meter {
  /** @ai-edited */
  constructor(name) {
    this.root = new St.BoxLayout({ vertical: true, style_class: "cu-meter" });

    const row = new St.BoxLayout({ style_class: "cu-meter-row" });
    this._name = new St.Label({ text: name, style_class: "cu-meter-name", x_expand: true });
    this._pct = new St.Label({ text: "—", style_class: "cu-meter-pct" });
    row.add_child(this._name);
    row.add_child(this._pct);

    this._track = new St.Widget({
      style_class: "cu-track",
      x_expand: true,
      layout_manager: new Clutter.FixedLayout(),
    });
    this._bar = new UsageBar();
    this._track.add_child(this._bar);
    this._marker = new St.Widget({ style_class: "cu-schedule-marker", visible: false });
    this._track.add_child(this._marker);
    this._schedule = null;
    // The fill is sized as a fraction of the track's *actual* allocated
    // width, recomputed whenever the track is (re)laid out. Sizing off a
    // fixed pixel constant left a 100% bar short of the end whenever the
    // popup stretched the track wider than that constant (issue #3).
    this._fraction = 0;
    // connectObject ties the handler to this meter, so destroy() can drop
    // it with a single disconnectObject(this).
    this._track.connectObject("notify::width", () => this._resizeFill(), this);

    // Small "8:00"/"18:00" label centred under the bar's dent.
    this._dent = null;
    this._markRow = new St.Widget({
      style_class: "cu-mark-row",
      x_expand: true,
      visible: false,
      layout_manager: new Clutter.FixedLayout(),
    });
    this._markLabel = new St.Label({ text: "", style_class: "cu-mark-label" });
    this._markRow.add_child(this._markLabel);
    this._markLabel.connectObject("notify::width", () => this._resizeFill(), this);

    this._caption = wrapLabel(new St.Label({ text: "", style_class: "cu-caption" }));

    this.root.add_child(row);
    this.root.add_child(this._track);
    this.root.add_child(this._markRow);
    this.root.add_child(this._caption);
  }

  // The bar width tracks actual utilization; rgb (defaults to the util's
  // own heat) drives the color, so projection can tint without resizing.
  /** @ai-edited */
  setValue(util, caption, rgb = heatRgb(util / 100), schedule = null, mark = null) {
    this._schedule = schedule;
    this._marker.visible = schedule !== null;
    this._marker.accessible_name = schedule === null ? "" : `On-schedule usage: ${Math.round(schedule * 100)}%`;
    this._pct.text = `${Math.round(util)}%`;
    this._fraction = Math.max(0, Math.min(100, util)) / 100;
    this._dent = mark?.fraction ?? null;
    this._markLabel.text = mark ? `${mark.hour}:00` : "";
    this._markRow.visible = mark !== null;
    this._bar.setState(this._fraction, rgb, this._dent);
    this._resizeFill();
    this._caption.text = caption ?? "";
    this._caption.visible = !!caption;
  }

  // Size the fill to the current fraction of the track's real width, so a
  // 100% window always reaches the end no matter how wide the popup lays the
  // track out. Called on every value change and on every track re-allocation
  // (the first allocation lands after construction, when width is still 0).
  /** @ai-edited */
  _resizeFill() {
    const w = this._track?.get_width() ?? 0;
    this._bar.set_width(w);
    if (this._schedule !== null) {
      const markerWidth = this._marker.get_width();
      const x = Math.max(0, Math.min(w - markerWidth, this._schedule * w - markerWidth / 2));
      this._marker.set_position(Math.round(x), -2);
    }
    if (this._dent !== null) {
      const labelWidth = this._markLabel.get_width();
      const x = Math.max(0, Math.min(w - labelWidth, this._dent * w - labelWidth / 2));
      this._markLabel.set_position(Math.round(x), 0);
    }
  }

  // Update the meter's title in place (a reused meter can change label, e.g.
  // if the API renames a scoped window).
  setName(name) {
    this._name.text = name;
  }

  /** @ai-edited */
  setMuted() {
    this._schedule = null;
    this._marker.visible = false;
    this._pct.text = "—";
    this._fraction = 0;
    this._dent = null;
    this._markRow.visible = false;
    this._bar.setState(0, null, null);
    this._caption.visible = false;
  }

  // Destroys the meter's actor tree and releases the owned references.
  // Each child is destroyed explicitly (leaf-first) so the destruction is
  // unambiguous to both the runtime and static review tooling.
  /** @ai-edited */
  destroy() {
    // Drop the track's notify::width handler before tearing the actors
    // down, so nothing can fire mid-destruction.
    this._track?.disconnectObject(this);
    this._markLabel?.disconnectObject(this);
    this._name?.destroy();
    this._pct?.destroy();
    this._bar?.destroy();
    this._marker?.destroy();
    this._markLabel?.destroy();
    this._markRow?.destroy();
    this._caption?.destroy();
    this._track?.destroy();
    this.root?.destroy();
    this._name = null;
    this._pct = null;
    this._bar = null;
    this._marker = null;
    this._markLabel = null;
    this._markRow = null;
    this._caption = null;
    this._track = null;
    this.root = null;
  }
}

// A compact circular usage gauge for the panel, drawn with Cairo.
const Ring = GObject.registerClass(
  class Ring extends St.DrawingArea {
    _init() {
      super._init({
        style_class: "cu-ring",
        width: RING_SIZE,
        height: RING_SIZE,
        y_align: Clutter.ActorAlign.CENTER,
      });
      this._util = null;
      this._color = null;
    }

    setValue(util, rgb = heatRgb(util / 100)) {
      this._util = Math.max(0, Math.min(100, util));
      this._color = rgb;
      this.queue_repaint();
    }

    setUnknown() {
      this._util = null;
      this._color = null;
      this.queue_repaint();
    }

    vfunc_repaint() {
      const cr = this.get_context();
      const [w, h] = this.get_surface_size();
      const cx = w / 2;
      const cy = h / 2;
      const radius = Math.min(w, h) / 2 - RING_WIDTH / 2;
      const start = -Math.PI / 2;

      cr.setLineWidth(RING_WIDTH);
      cr.setLineCap(Cairo.LineCap.ROUND);

      // Track tint follows the panel's text color, so it stays visible on
      // both light and dark themes.
      const [fr, fg, fb] = colorRgb(this.get_theme_node().get_foreground_color());
      cr.setSourceRGBA(fr, fg, fb, 0.22);
      cr.arc(cx, cy, radius, 0, 2 * Math.PI);
      cr.stroke();

      if (this._util !== null && this._util > 0) {
        const [r, g, b] = this._color ?? heatRgb(this._util / 100);
        cr.setSourceRGBA(r, g, b, 1);
        cr.arc(cx, cy, radius, start, start + (this._util / 100) * 2 * Math.PI);
        cr.stroke();
      }

      cr.$dispose();
    }
  },
);

// A compact horizontal usage bar for the panel: the same data as the ring, but
// drawn as a small track + fill. Mirrors the Ring API (setValue/setUnknown).
class PanelBar {
  constructor() {
    this.root = new St.BoxLayout({
      style_class: "cu-panel-bar",
      y_align: Clutter.ActorAlign.CENTER,
    });
    this._fill = new St.Widget({ style_class: "cu-panel-bar-fill" });
    this.root.add_child(this._fill);
  }

  setValue(util, rgb = heatRgb(util / 100)) {
    const clamped = Math.max(0, Math.min(100, util));
    this._fill.set_width(Math.round((clamped / 100) * PANEL_BAR_WIDTH));
    this._fill.style = `background-color: ${rgbCss(rgb)};`;
  }

  setUnknown() {
    this._fill.set_width(0);
    this._fill.style = null;
  }

  // Destroys the bar's actor tree and releases the owned references.
  destroy() {
    this._fill?.destroy();
    this.root?.destroy();
    this._fill = null;
    this.root = null;
  }
}

// Everything one usage source shows: its panel block (ring/bar, percentage,
// reset countdown, tier) and its popup section (logo, name, plan pill, one
// meter per usage window, an extra-info line, and an error line). The service
// specifics — how to fetch, how to fill the header, what errors mean — live
// in the subclasses: ProfileView (one Claude Code profile) and CodexView.
// Instances are orchestrated by a UsageIndicator, which shares a single panel
// icon, poll timer, and countdown across its views.
class UsageView {
  constructor({ name, logoFile, chip = null, logTag, pillClass = "cu-pill" }, settings, panelBox, sectionsBox, isFirst) {
    this._settings = settings;
    this._displayName = name;
    this._logTag = logTag;
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

  // Instant, network-free tier from local credentials. Optional per service.
  async applyTierFromDisk(_cancellable) {}

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
  // preference.
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

  // Popup text for a failed refresh; subclasses name their own service.
  _errorMessage(e) {
    return e.message || "Could not reach the usage service";
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

// One Claude Code profile (one config directory / one account).
class ProfileView extends UsageView {
  constructor(profile, settings, panelBox, sectionsBox, showChip, isFirst, allowSharedToken, path) {
    super(
      {
        name: profile.label,
        logoFile: `${path}/icons/octopus.png`,
        chip: showChip ? profileChip(profile.label) : null,
        logTag: "claude-usage",
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
      this._extra.visible = false;
      this._extra.style_class = "cu-extra";
      return;
    }
    const parts = [spend.used, spend.limit].filter(Boolean);
    let text = `Extra usage: ${parts.join(" / ")}`;
    if (spend.percent !== null) text += ` (${spend.percent}%)`;
    this._extra.text = text;
    this._extra.style_class = `cu-extra ${levelClass(spend.level)}`;
    this._extra.visible = true;
  }

  _errorMessage(e) {
    if (e instanceof UsageError && e.status === 401) return "Session expired. Sign in via Claude Code or Settings.";
    if (e instanceof UsageError && e.status === 403) {
      // The API refuses to serve usage for this account: typically no
      // active subscription, even though auth itself succeeded (so the
      // profile fetch above can still show a stale plan/tier). Prefer
      // the API's own wording since it may name the actual cause.
      return e.apiMessage() || "No active Claude subscription for this account.";
    }
    if (e instanceof UsageError && e.status === 429) return "Rate limited by Claude; will retry shortly.";
    return e.message || "Could not reach Claude";
  }
}

// The Codex (ChatGPT) account signed in through the Codex CLI.
class CodexView extends UsageView {
  constructor(settings, panelBox, sectionsBox, path) {
    super(
      {
        name: "Codex",
        logoFile: `${path}/icons/codex.png`,
        logTag: "codex-usage",
        pillClass: "cu-pill cu-pill-codex",
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
    this._extra.text = lines.join("\n");
    this._extra.visible = lines.length > 0;

    this.renderPanel();
    this.lastResult = "ok";
  }

  _errorMessage(e) {
    if (e instanceof UsageError && e.status === 401) return "Codex session expired. Run `codex` once to refresh its sign-in.";
    if (e instanceof UsageError && e.status === 403) return e.apiMessage() || "No active ChatGPT subscription for this account.";
    if (e instanceof UsageError && e.status === 429) return "Rate limited by ChatGPT; will retry shortly.";
    return e.message || "Could not reach ChatGPT";
  }
}

// One panel button with its own popup, poll timer, and countdown, showing one
// or more UsageViews side by side. The extension creates one per service, so
// Claude and Codex each get their own indicator in the top bar.
const UsageIndicator = GObject.registerClass(
  class UsageIndicator extends PanelMenu.Button {
    _init(name, { path, settings, openPreferences, iconFile, usageUrl }) {
      super._init(0.5, name);

      this._path = path;
      this._settings = settings;
      this._openPreferences = openPreferences;
      this._busy = false;
      this._cancellable = new Gio.Cancellable();
      this._lastFetchMs = 0;
      this._views = [];
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
        this,
      );

      this._applyVisibility();
    }

    // Replaces the views with build()'s, then fetches them all right away.
    _setViews(build) {
      this._destroyViews();
      this._views = build();
      this._applyVisibility();
      for (const view of this._views) view.applyTierFromDisk(this._cancellable);
      this._refresh(true);
      this._startTimer();
    }

    _destroyViews() {
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
    _refresh(force = false) {
      if (this._busy || this._views.length === 0) return;
      if (!force && Date.now() - this._lastFetchMs < MIN_REFRESH_MS) return;
      this._busy = true;
      this._lastFetchMs = Date.now();

      const cancellable = this._cancellable;
      Promise.allSettled(this._views.map((view) => view.refresh(cancellable))).finally(() => {
        this._busy = false;
        if (cancellable.is_cancelled()) return;
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

// The Claude indicator: one ProfileView per configured Claude Code profile.
const ClaudeUsageIndicator = GObject.registerClass(
  class ClaudeUsageIndicator extends UsageIndicator {
    _init(path, settings, openPreferences) {
      super._init("Claude Code Usage Monitor", {
        path,
        settings,
        openPreferences,
        iconFile: `${path}/icons/claude-spark.svg`,
        usageUrl: CLAUDE_USAGE_URL,
      });

      this._settings.connectObject(
        // Signing in (or out) from prefs changes the token source; refetch.
        "changed::access-token",
        () => this._refresh(true),
        // Profiles were added/removed/renamed/repointed in prefs.
        "changed::profiles",
        () => this._rebuildFromSettings(),
        this,
      );

      this._initProfiles();
    }

    // One-time async setup: seeds the profile list (auto-detection) if it's
    // empty, then builds the views. Later profile edits go through
    // _rebuildFromSettings() instead, which is synchronous and cheap.
    async _initProfiles() {
      const cancellable = this._cancellable;
      const profiles = await ensureProfiles(this._settings);
      if (cancellable.is_cancelled()) return;
      this._buildProfileViews(profiles);
    }

    _rebuildFromSettings() {
      this._buildProfileViews(loadProfiles(this._settings));
    }

    _buildProfileViews(profiles) {
      const showChip = profiles.length > 1;
      // Only the profile the single in-app token can belong to may fall back
      // to it: the sole profile, or the one owning the default ~/.claude dir.
      const defaultDir = Gio.File.new_for_path(defaultConfigDir());
      this._setViews(() =>
        profiles.map((profile, i) => {
          const ownsDefaultDir = Gio.File.new_for_path(profile.configDir).equal(defaultDir);
          const allowSharedToken = profiles.length === 1 || ownsDefaultDir;
          return new ProfileView(
            profile,
            this._settings,
            this._panelBox,
            this._sectionsBox,
            showChip,
            i === 0,
            allowSharedToken,
            this._path,
          );
        }),
      );
    }
  },
);

// The Codex indicator: the single ChatGPT account the Codex CLI is signed in to.
const CodexUsageIndicator = GObject.registerClass(
  class CodexUsageIndicator extends UsageIndicator {
    _init(path, settings, openPreferences) {
      super._init("Codex Usage Monitor", {
        path,
        settings,
        openPreferences,
        iconFile: `${path}/icons/codex.png`,
        usageUrl: CODEX_USAGE_URL,
      });
      this._setViews(() => [new CodexView(this._settings, this._panelBox, this._sectionsBox, this._path)]);
    }
  },
);

export default class ClaudeUsageExtension extends Extension {
  enable() {
    this._settings = this.getSettings();
    this._claude = null;
    this._codex = null;
    // Watch the placement and per-service keys so changes apply
    // immediately, with no reload and no logging out.
    this._settings.connectObject(
      "changed::panel-position",
      () => this._place(),
      "changed::panel-index",
      () => this._place(),
      "changed::show-claude",
      () => this._syncIndicators(),
      "changed::show-codex",
      () => this._syncIndicators(),
      this,
    );
    this._syncIndicators();

    // Optional shortcuts that open each popup, the same as clicking the
    // indicator — the shell binds its own panel menus this way (Super+S
    // for quick settings). Unbound by default, so nothing is taken from
    // the user until they choose a combination. Meta follows the GSettings
    // keys themselves, so changing a shortcut needs no extra plumbing.
    // POPUP matters: while a dropdown is open the shell is in popup mode,
    // and a binding without it goes silent — so the shortcut could open
    // the menu but never close it again.
    const modes = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP;
    Main.wm.addKeybinding("toggle-menu", this._settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, modes, () => this._claude?.menu.toggle());
    Main.wm.addKeybinding("toggle-codex-menu", this._settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, modes, () =>
      this._codex?.menu.toggle(),
    );
  }

  // Creates or destroys each service's indicator to match its show-* key,
  // then re-places whatever is left.
  _syncIndicators() {
    const wantClaude = this._settings.get_boolean("show-claude");
    const wantCodex = this._settings.get_boolean("show-codex");
    if (wantClaude && !this._claude) {
      this._claude = new ClaudeUsageIndicator(this.path, this._settings, () => this.openPreferences());
    } else if (!wantClaude && this._claude) {
      this._claude.destroy();
      this._claude = null;
    }
    if (wantCodex && !this._codex) {
      this._codex = new CodexUsageIndicator(this.path, this._settings, () => this.openPreferences());
    } else if (!wantCodex && this._codex) {
      this._codex.destroy();
      this._codex = null;
    }
    this._place();
  }

  // Puts the indicators side by side in the configured panel box, Claude
  // first and Codex right after it. addToStatusArea refuses a role that is
  // already registered, so the registrations are cleared first; the
  // indicators themselves are reused, so moving them costs no refetch and
  // leaves the poll timers and current readings alone.
  _place() {
    const codexRole = `${this.uuid}-codex`;
    for (const role of [this.uuid, codexRole]) {
      if (Main.panel.statusArea[role]) Main.panel.statusArea[role] = null;
    }
    const box = this._settings.get_string("panel-position");
    let index = this._settings.get_int("panel-index");
    if (this._claude) Main.panel.addToStatusArea(this.uuid, this._claude, index++, box);
    if (this._codex) Main.panel.addToStatusArea(codexRole, this._codex, index, box);
  }

  disable() {
    Main.wm.removeKeybinding("toggle-menu");
    Main.wm.removeKeybinding("toggle-codex-menu");
    this._settings?.disconnectObject(this);
    this._settings = null;
    this._claude?.destroy();
    this._claude = null;
    this._codex?.destroy();
    this._codex = null;
  }
}
