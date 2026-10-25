// Shell widgets shared by every usage view: the popup meter (title, bar,
// reset caption) and the two panel gauges (ring and bar).

import GObject from "gi://GObject";
import St from "gi://St";
import Clutter from "gi://Clutter";
import Pango from "gi://Pango";
import Cairo from "cairo";

import { heatRgb, rgbCss } from "../lib/format.js";

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
export function colorRgb(c) {
  const scale = Math.max(c.red, c.green, c.blue) > 1 ? 255 : 1;
  return [c.red / scale, c.green / scale, c.blue / scale];
}

// Let a fixed-width popup label wrap onto extra lines instead of running off
// the edge. Pango only wraps when the text actually exceeds the width, so short
// text stays on one line. Returns the label for chaining.
export function wrapLabel(label) {
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
export class Meter {
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
export const Ring = GObject.registerClass(
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
export class PanelBar {
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
