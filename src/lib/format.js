// Pure display helpers shared by every usage view: severity levels, the burn
// projection, and duration/countdown text. No GI or shell imports, so they run
// under plain `node` as well as in the shell.

// Severity levels, least to most severe.
export const LEVEL_RANK = { ok: 0, warn: 1, crit: 2 };

// Severity from a raw utilization %: how full the bucket is right now.
export function utilLevel(util) {
  if (util >= 90) return "crit";
  if (util >= 75) return "warn";
  return "ok";
}

// The more severe of two levels.
export function maxLevel(a, b) {
  return LEVEL_RANK[a] >= LEVEL_RANK[b] ? a : b;
}

// Style-class suffix for a level (cu-ok / cu-warn / cu-crit).
export function levelClass(level) {
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
export function heatRgb(heat) {
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
export function rgbCss([r, g, b]) {
  const byte = (v) => Math.round(v * 255);
  return `rgb(${byte(r)}, ${byte(g)}, ${byte(b)})`;
}

// Projected end-of-window utilization at the current consumption rate. Returns
// the larger of actual and projected, falling back to actual when the window
// has barely started (too little signal) or reports no reset time.
export function projectedUtil(util, resetsAtIso, totalSeconds) {
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
export function exhaustSeconds(util, resetsAtIso, totalSeconds) {
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
export function humanDuration(seconds, sep = " ") {
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
export function windowLevel(util, resetsAtIso, totalSeconds) {
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
export function projectionNote(util, resetsAtIso, totalSeconds) {
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

export function relativeReset(iso) {
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
export function compactReset(iso) {
  const target = Date.parse(iso);
  if (Number.isNaN(target)) return "";
  const diff = target - Date.now();
  if (diff <= 0) return "now";
  return humanDuration(diff / 1000, "");
}
