// Pure timing helpers shared by the panel gauges and popup schedule markers.

/** Elapsed fraction of a reset window, or null without usable timing.
 * @ai-generated
 */
export function scheduleFraction(resetsAt, totalSeconds, now = Date.now()) {
  const reset = Date.parse(resetsAt ?? "");
  if (!Number.isFinite(reset) || !Number.isFinite(totalSeconds) || totalSeconds <= 0) return null;
  return Math.max(0, Math.min(1, 1 - (reset - now) / (totalSeconds * 1000)));
}

/** The next local clock mark (default 08:00 or 18:00, whichever comes first
 * after `now`) as `{fraction, hour}`, where `fraction` is its position in the
 * reset window. Null when that mark falls at or after the reset, or when
 * timing is unusable.
 * @ai-generated
 */
export function nextClockMark(resetsAt, totalSeconds, now = Date.now(), hourMarks = [8, 18]) {
  const reset = Date.parse(resetsAt ?? "");
  if (!Number.isFinite(reset) || !Number.isFinite(totalSeconds) || totalSeconds <= 0) return null;
  const today = new Date(now);
  let next = null;
  for (const dayOffset of [0, 1]) {
    for (const hour of hourMarks) {
      const t = new Date(today.getFullYear(), today.getMonth(), today.getDate() + dayOffset, hour).getTime();
      if (t > now && (next === null || t < next.t)) next = { t, hour };
    }
  }
  if (next === null || next.t >= reset) return null;
  const span = totalSeconds * 1000;
  const fraction = (next.t - (reset - span)) / span;
  return fraction > 0 ? { fraction, hour: next.hour } : null;
}

const BLUE = [0x35 / 255, 0x84 / 255, 0xe4 / 255];
const GREEN = [0x33 / 255, 0xd1 / 255, 0x7a / 255];
const YELLOW = [0xf6 / 255, 0xd3 / 255, 0x2d / 255];
const AMBER = [0xff / 255, 0x78 / 255, 0x00 / 255];
const RED = [0xe0 / 255, 0x1b / 255, 0x24 / 255];

// Pace (in % of the evenly spread budget) at which each colour is reached in
// full; colours blend linearly in between. Mirrors the `pace-*` GSettings keys.
export const DEFAULT_PACE_THRESHOLDS = Object.freeze({
  blue: 50,
  green: 100,
  yellow: 110,
  amber: 120,
  red: 150,
});

// GSettings key for each threshold, shared by the extension and prefs.
export const PACE_THRESHOLD_KEYS = Object.freeze({
  blue: "pace-blue",
  green: "pace-green",
  yellow: "pace-yellow",
  amber: "pace-amber",
  red: "pace-red",
});

/** Reads the thresholds from a Gio.Settings-like object (needs `get_int`).
 * @ai-generated
 */
export function paceThresholdsFromSettings(settings) {
  const out = {};
  for (const [name, key] of Object.entries(PACE_THRESHOLD_KEYS)) out[name] = settings.get_int(key);
  return out;
}

/** Builds `[ratio, rgb]` gradient stops from percentage thresholds. Missing or
 * invalid values fall back to the defaults, and a threshold set below the one
 * before it is raised to match, so the gradient always runs blue to red.
 * @ai-generated
 */
export function paceStops(thresholds = DEFAULT_PACE_THRESHOLDS) {
  const order = [
    ["blue", BLUE],
    ["green", GREEN],
    ["yellow", YELLOW],
    ["amber", AMBER],
    ["red", RED],
  ];
  let prev = 0;
  return order.map(([name, colour]) => {
    const raw = Number(thresholds?.[name]);
    const pct = Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_PACE_THRESHOLDS[name];
    prev = Math.max(prev, pct / 100);
    return [prev, colour];
  });
}

const DEFAULT_STOPS = paceStops();

/** Usage relative to the evenly spread budget; 1 means exactly on schedule.
 * Expired windows or a window that has not started have no reliable pace.
 * @ai-generated
 */
export function paceRatio(util, resetsAt, totalSeconds, now = Date.now()) {
  if (!Number.isFinite(util)) return null;
  const elapsed = scheduleFraction(resetsAt, totalSeconds, now);
  if (elapsed === null || elapsed <= 0 || elapsed >= 1) return null;
  return Math.max(0, util) / 100 / elapsed;
}

/** Shared blue-to-red pace colour; exhausted budgets always show red.
 * Returns null when timing is unavailable for a budget below 100% usage.
 * `thresholds` overrides DEFAULT_PACE_THRESHOLDS (see paceStops).
 * @ai-generated
 */
export function paceRgb(util, resetsAt, totalSeconds, now = Date.now(), thresholds = null) {
  const stops = thresholds ? paceStops(thresholds) : DEFAULT_STOPS;
  const last = stops[stops.length - 1][1];
  if (Number.isFinite(util) && util >= 100) return [...last];
  const ratio = paceRatio(util, resetsAt, totalSeconds, now);
  if (ratio === null) return null;
  if (ratio <= stops[0][0]) return [...stops[0][1]];
  for (let i = 1; i < stops.length; i++) {
    const [p1, c1] = stops[i];
    if (ratio <= p1) {
      const [p0, c0] = stops[i - 1];
      // Equal thresholds give a hard edge instead of dividing by zero.
      const t = p1 > p0 ? (ratio - p0) / (p1 - p0) : 1;
      return c0.map((v, k) => v + (c1[k] - v) * t);
    }
  }
  return [...last];
}
