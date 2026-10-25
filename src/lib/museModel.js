// Pure data-shaping for Meta Muse Code. The usage comes from the same call the
// `muse usage` command makes, POST api.meta.ai/muse-code/key, whose response
// (undocumented) carries the account and subscription:
//   {is_subs_active, subs_tier_name, user_full_name, user_email, ...,
//    subs_usage: {window: {used_percent, window_duration_mins, resets_at},
//                 weekly: {used_percent, resets_at}} | null}
// subs_usage is null "before your first use in a new window" (the CLI's own
// wording). Its field names come from the CLI binary and have not been seen in
// a live payload yet, so timestamps are accepted as epoch s/ms or ISO, and both
// snake_case and camelCase spellings are read.
// Produces the shared window shape (see windows.js). Runs under plain `node`.

import { ROLE_ORDER, SEVEN_DAY_SECONDS, DAY_SECONDS, clampPercent, toIso, windowLengthLabel } from "./windows.js";

const pick = (obj, ...names) => {
  for (const n of names) if (obj?.[n] !== undefined && obj?.[n] !== null) return obj[n];
  return undefined;
};

function fromSnapshot(snap, key, fallbackSeconds) {
  const utilization = clampPercent(pick(snap, "used_percent", "usedPercent"));
  if (utilization === null) return null;
  const mins = Number(pick(snap, "window_duration_mins", "windowDurationMins"));
  const totalSeconds = Number.isFinite(mins) && mins > 0 ? mins * 60 : fallbackSeconds;
  const role = totalSeconds && totalSeconds < DAY_SECONDS ? "session" : "weekly";
  return {
    key: `muse:${key}`,
    label: key === "weekly" ? "Weekly" : windowLengthLabel(totalSeconds),
    role,
    utilization,
    resetsAt: toIso(pick(snap, "resets_at", "resetsAtMs", "resetsAt")),
    totalSeconds: totalSeconds ?? null,
    apiLevel: "ok",
    isActive: false,
    order: ROLE_ORDER[role],
  };
}

/**
 * Ordered windows (the rolling window, then the weekly one); empty when the
 * server sent no usage. Accepts the key response or the bare subs_usage.
 * @ai-generated
 */
export function normalizeMuseWindows(keyInfo) {
  const usage = keyInfo?.subs_usage ?? keyInfo?.allowance ?? (keyInfo?.window || keyInfo?.weekly ? keyInfo : null);
  if (!usage) return [];
  const out = [fromSnapshot(usage.window, "window", null), fromSnapshot(usage.weekly, "weekly", SEVEN_DAY_SECONDS)].filter(Boolean);
  out.sort((a, b) => a.order - b.order);
  return out;
}

// Plan label for the pill: the tier name with the product prefix dropped
// ("Muse Code Everyday Usage" -> "EVERYDAY USAGE"); "MUSE" if unknown.
export function musePlanLabel(keyInfo) {
  return (
    String(keyInfo?.subs_tier_name ?? "")
      .replace(/^(meta\s+)?muse(\s+code)?\s*/i, "")
      .trim()
      .toUpperCase() || "MUSE"
  );
}
