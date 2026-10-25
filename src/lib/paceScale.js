// Preferences widget: a 0-200% pace scale painted with the live gauge
// gradient, with one draggable cursor per colour threshold. GTK only (no shell
// imports), so it can also be rendered from a plain `gjs` script.

import Gtk from "gi://Gtk";
import Gdk from "gi://Gdk";
import PangoCairo from "gi://PangoCairo";
import Cairo from "cairo";

import { PACE_THRESHOLD_KEYS, paceStops } from "./usagePace.js";

export const PACE_SCALE_MAX = 200;

const NAMES = Object.keys(PACE_THRESHOLD_KEYS);
const KEYS = Object.values(PACE_THRESHOLD_KEYS);
const TITLES = { blue: "Blue", green: "Green", yellow: "Yellow", amber: "Amber", red: "Red" };

const PAD = 20; // room at both ends so edge cursors and labels fit
const ROW = 16; // height of one row of cursor labels
const KNOB = 8; // cursor radius
const BAR_H = 12;
const BAR_Y = 2 * ROW + 6 + KNOB; // bar centre, below two staggered label rows
const HEIGHT = BAR_Y + BAR_H / 2 + 26;

/**
 * Builds the pace scale bound to the `pace-*` keys of `settings`.
 *
 * Drag a cursor (or click the bar to pull the nearest one over). Cursors
 * cannot pass their neighbours, so the colours always run blue to red; when
 * several are stacked, the drag direction decides which one moves. With the
 * scale focused, Left/Right nudge the selected cursor (Shift: by 10) and
 * Up/Down switch cursor. Every change is written straight to GSettings, so
 * the panel gauges recolour live.
 * @ai-generated
 */
export function buildPaceScale(settings) {
  const area = new Gtk.DrawingArea({
    content_height: HEIGHT,
    hexpand: true,
    focusable: true,
    has_tooltip: true,
  });
  let selected = null;

  const values = () => KEYS.map((k) => settings.get_int(k));
  const span = () => Math.max(1, area.get_width() - 2 * PAD);
  const toX = (pct) => PAD + (Math.max(0, Math.min(PACE_SCALE_MAX, pct)) / PACE_SCALE_MAX) * span();
  const toPct = (x) => Math.round(((x - PAD) / span()) * PACE_SCALE_MAX);

  const setValue = (i, pct) => {
    const v = values();
    const lo = i > 0 ? v[i - 1] : 0;
    const hi = i < v.length - 1 ? v[i + 1] : PACE_SCALE_MAX;
    const clamped = Math.max(lo, Math.min(hi, pct));
    if (clamped !== v[i]) settings.set_int(KEYS[i], clamped);
  };

  // Indices of the cursors closest to x (several when they are stacked).
  const nearest = (x) => {
    const dist = values().map((p) => Math.abs(toX(p) - x));
    const best = Math.min(...dist);
    return dist.flatMap((d, i) => (d - best < 0.5 ? [i] : []));
  };

  // ---- dragging ----
  const drag = new Gtk.GestureDrag();
  let candidates = [];
  let startX = 0;
  let grabOffset = 0;
  let pending = false;
  const pick = (dir) => {
    selected = dir < 0 ? Math.min(...candidates) : Math.max(...candidates);
    pending = false;
  };
  drag.connect("drag-begin", (_g, x) => {
    area.grab_focus();
    startX = x;
    candidates = nearest(x);
    const hx = toX(values()[candidates[0]]);
    if (Math.abs(x - hx) > KNOB) {
      // Clicked the bar: pull the nearest cursor to the pointer.
      grabOffset = 0;
      pick(x - hx);
      setValue(selected, toPct(x));
    } else {
      grabOffset = hx - x;
      if (candidates.length === 1) {
        selected = candidates[0];
        pending = false;
      } else {
        pending = true;
      }
    }
    area.queue_draw();
  });
  drag.connect("drag-update", (_g, dx) => {
    if (pending) {
      if (dx === 0) return;
      pick(dx);
    }
    if (selected !== null) setValue(selected, toPct(startX + dx + grabOffset));
  });
  drag.connect("drag-end", () => {
    if (pending) pick(-1);
    area.queue_draw();
  });
  area.add_controller(drag);

  // ---- keyboard ----
  const keyCtl = new Gtk.EventControllerKey();
  keyCtl.connect("key-pressed", (_c, keyval, _code, state) => {
    const step = state & Gdk.ModifierType.SHIFT_MASK ? 10 : 1;
    const cur = selected ?? 0;
    switch (keyval) {
      case Gdk.KEY_Left:
      case Gdk.KEY_Right:
        selected = cur;
        setValue(cur, values()[cur] + (keyval === Gdk.KEY_Left ? -step : step));
        area.queue_draw();
        return true;
      case Gdk.KEY_Up:
      case Gdk.KEY_Down:
        selected = (cur + (keyval === Gdk.KEY_Down ? 1 : KEYS.length - 1)) % KEYS.length;
        area.queue_draw();
        return true;
      default:
        return false;
    }
  });
  area.add_controller(keyCtl);
  area.connect("notify::has-focus", () => area.queue_draw());

  area.connect("query-tooltip", (_w, x, _y, _kb, tooltip) => {
    const [i] = nearest(x);
    const v = values();
    if (Math.abs(toX(v[i]) - x) > KNOB + 4) return false;
    tooltip.set_text(`${TITLES[NAMES[i]]}: reached in full at ${v[i]}% pace`);
    return true;
  });

  for (const key of KEYS) settings.connect(`changed::${key}`, () => area.queue_draw());

  area.set_draw_func((_a, cr, width) => {
    drawPaceScale(area, cr, width, values(), area.has_focus ? selected : null);
    cr.$dispose();
  });
  return area;
}

/**
 * Paints the scale: gradient bar, 25% ticks with labels every 50%, and the
 * cursors with their values on two staggered rows so neighbours don't overlap.
 * @ai-generated
 */
function drawPaceScale(widget, cr, width, values, selected) {
  const fg = widget.get_color();
  const ink = (alpha) => cr.setSourceRGBA(fg.red, fg.green, fg.blue, alpha);
  const left = PAD;
  const span = Math.max(1, width - 2 * PAD);
  const x = (pct) => left + (Math.max(0, Math.min(PACE_SCALE_MAX, pct)) / PACE_SCALE_MAX) * span;
  const stops = paceStops(Object.fromEntries(NAMES.map((n, i) => [n, values[i]])));

  const text = (str, cx, top, alpha) => {
    const layout = widget.create_pango_layout(null);
    layout.set_markup(`<small>${str}</small>`, -1);
    const [w] = layout.get_pixel_size();
    ink(alpha);
    cr.moveTo(Math.max(0, Math.min(width - w, cx - w / 2)), top);
    PangoCairo.show_layout(cr, layout);
    cr.newPath();
  };

  // Gradient bar (PAD extend keeps blue before the first stop, red after the last).
  const grad = new Cairo.LinearGradient(left, 0, left + span, 0);
  for (const [ratio, [r, g, b]] of stops) grad.addColorStopRGB(Math.min(1, (ratio * 100) / PACE_SCALE_MAX), r, g, b);
  const top = BAR_Y - BAR_H / 2;
  const rad = BAR_H / 2;
  cr.newSubPath();
  cr.arc(left + rad, top + rad, rad, Math.PI / 2, (3 * Math.PI) / 2);
  cr.arc(left + span - rad, top + rad, rad, -Math.PI / 2, Math.PI / 2);
  cr.closePath();
  cr.setSource(grad);
  cr.fill();

  // Ticks and labels.
  const tickTop = BAR_Y + BAR_H / 2 + 3;
  cr.setLineWidth(1);
  ink(0.5);
  for (let p = 0; p <= PACE_SCALE_MAX; p += 25) {
    const tx = Math.round(x(p)) + 0.5;
    cr.moveTo(tx, tickTop);
    cr.lineTo(tx, tickTop + (p % 50 === 0 ? 6 : 3));
  }
  cr.stroke();
  for (let p = 0; p <= PACE_SCALE_MAX; p += 50) text(`${p}%`, x(p), tickTop + 7, p === 100 ? 0.9 : 0.6);

  // Cursors, with value labels alternating between two rows.
  values.forEach((pct, i) => {
    const kx = x(pct);
    const labelTop = (i % 2) * ROW;
    ink(0.35);
    cr.setLineWidth(1);
    cr.moveTo(Math.round(kx) + 0.5, labelTop + ROW);
    cr.lineTo(Math.round(kx) + 0.5, BAR_Y - KNOB);
    cr.stroke();
    text(`${pct}%`, kx, labelTop, i === selected ? 1 : 0.8);

    const [r, g, b] = stops[i][1];
    cr.newPath(); // drop the label's current point, or arc() joins it with a line
    cr.arc(kx, BAR_Y, i === selected ? KNOB + 1 : KNOB, 0, 2 * Math.PI);
    cr.setSourceRGB(r, g, b);
    cr.fillPreserve();
    cr.setLineWidth(i === selected ? 3 : 2);
    ink(i === selected ? 1 : 0.85);
    cr.stroke();
  });
}
