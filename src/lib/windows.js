// Shared vocabulary for normalised usage windows, the one shape every service
// model produces and every view renders:
//   {key, label, role, utilization, resetsAt, totalSeconds, apiLevel, isActive, order}
// role is 'session' | 'weekly' | 'monthly' | 'scoped' | 'other'; the panel's
// "5-hour" / "7-day" choices pick the session / weekly window and fall back to
// the first one. No imports: runs under plain `node`.

export const DAY_SECONDS = 24 * 3600;
export const FIVE_HOUR_SECONDS = 5 * 3600;
export const SEVEN_DAY_SECONDS = 7 * DAY_SECONDS;

export const ROLE_ORDER = { session: 0, weekly: 1, monthly: 2, scoped: 3, other: 4 };

// "5-hour", "7-day", or a generic length for a window the API adds later.
export function windowLengthLabel(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s <= 0) return "Usage";
  if (s % DAY_SECONDS === 0) return `${s / DAY_SECONDS}-day`;
  if (s % 3600 === 0) return `${s / 3600}-hour`;
  return `${Math.round(s / 60)}-minute`;
}

/**
 * ISO string for a timestamp that may be epoch seconds, epoch milliseconds,
 * or already an ISO/date string. Null when it cannot be parsed.
 * @ai-generated
 */
export function toIso(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (Number.isFinite(n)) {
    if (n <= 0) return null;
    // Anything past ~2001 in ms is > 1e12; epoch seconds stay far below that.
    return new Date(n > 1e12 ? n : n * 1000).toISOString();
  }
  const t = Date.parse(String(value));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

// Clamp a percentage to [0, 100], or null when it is not a number.
export function clampPercent(value) {
  const n = Number(value);
  if (value === null || value === undefined || !Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, n));
}
