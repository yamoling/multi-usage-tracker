// Pure data-shaping for Mistral Vibe. The Vibe CLI itself exposes no usage
// limits; the monthly allowances shown on admin.mistral.ai/subscription come
// from that site's tRPC route `billing.budget` (undocumented):
//   {usage_percentage, initial_budget, currency, reset_at,      <- API budget
//    api_budget:  {usage_percentage, initial_budget, currency, reset_at},
//    vibe_budget: {usage_percentage, initial_budget, currency, reset_at}}
// and the plan from `user.meSession` (organization.active_chat_plan, ...).
// Produces the shared window shape (see windows.js). No imports beyond
// windows.js: runs under plain `node` (tools/test-vibeModel.mjs).

import { ROLE_ORDER, clampPercent, toIso } from "./windows.js";

/**
 * Length in seconds of the calendar month that ends at `resetIso` (the
 * allowance resets on the 1st of each month, UTC). Null without a reset time.
 * @ai-generated
 */
export function monthSecondsEndingAt(resetIso) {
  const end = Date.parse(resetIso ?? "");
  if (Number.isNaN(end)) return null;
  const d = new Date(end);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes());
  return (end - start) / 1000;
}

function fromBudget(budget, key, label) {
  const utilization = clampPercent(budget?.usage_percentage);
  if (utilization === null || !(Number(budget?.initial_budget) > 0)) return null;
  const resetsAt = toIso(budget.reset_at);
  return {
    key: `vibe:${key}`,
    label,
    role: "monthly",
    utilization,
    resetsAt,
    totalSeconds: monthSecondsEndingAt(resetsAt),
    apiLevel: "ok",
    isActive: false,
    order: ROLE_ORDER.monthly,
  };
}

/**
 * Ordered windows: the Vibe Code allowance first (what the indicator is
 * about), then the included API allowance. Budgets of 0 are skipped.
 * @ai-generated
 */
export function normalizeVibeWindows(budget) {
  // Older payloads only carry the flat (API) budget at the top level.
  const vibe = fromBudget(budget?.vibe_budget, "code", "Vibe Code (monthly)");
  const api = fromBudget(budget?.api_budget ?? (budget?.vibe_budget ? null : budget), "api", "API (monthly)");
  return [vibe, api].filter(Boolean);
}

// "€126.61"; falls back to "126.61 EUR" when Intl lacks the currency.
export function formatMoney(amount, currency) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return null;
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency: currency || "EUR" }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency ?? ""}`.trim();
  }
}

/**
 * Money lines for the popup, one per budget: "Vibe Code: €126.61 of €127.50".
 * The API reports a percentage and the total, so the spent amount is derived.
 * @ai-generated
 */
export function vibeSpendLines(budget) {
  const lines = [];
  for (const [name, b] of [
    ["Vibe Code", budget?.vibe_budget],
    ["API", budget?.api_budget],
  ]) {
    const total = Number(b?.initial_budget);
    const pct = Number(b?.usage_percentage);
    if (!(total > 0) || !Number.isFinite(pct)) continue;
    lines.push(`${name}: ${formatMoney((total * pct) / 100, b.currency)} of ${formatMoney(total, b.currency)}`);
  }
  return lines;
}

// Plan label for the pill, from the organisation's active plan token. Only
// the one opaque token is renamed (INDIVIDUAL is what the site calls Pro);
// anything else shows through as-is, so new plans need no code change.
export function vibePlanLabel(session) {
  const org = session?.organization ?? {};
  const raw = org.active_chat_plan ?? org.active_code_plan ?? (org.has_vibe_pro ? "PRO" : null);
  const plan = String(raw ?? "")
    .replace(/^INDIVIDUAL$/i, "PRO")
    .replace(/[_-]+/g, " ")
    .trim()
    .toUpperCase();
  return plan || "VIBE";
}

// Display name for the subtitle, or null.
export function vibeAccountName(session) {
  return session?.name || [session?.first_name, session?.last_name].filter(Boolean).join(" ") || session?.email || null;
}

/**
 * Pulls the JSON payload out of a tRPC response ({result: {data: {json}}}).
 * Returns undefined when the body is not a tRPC result, which is what the
 * route answers with (an Ory login-flow object) when the session is invalid.
 * @ai-generated
 */
export function unwrapTrpc(body) {
  const data = body?.result?.data;
  if (!data || typeof data !== "object") return undefined;
  return "json" in data ? data.json : data;
}

/**
 * Extracts the `ory_session_*` cookie pair from what the user pasted: a full
 * Cookie header, a single `name=value` pair, or just the bare value (paired
 * with `defaultName`). Returns null when nothing usable is found.
 * @ai-generated
 */
export function parseSessionCookie(text, defaultName) {
  const raw = String(text ?? "")
    .trim()
    .replace(/^cookie:\s*/i, "");
  if (!raw) return null;
  const pairs = raw
    .split(";")
    .map((p) => p.trim())
    .filter(Boolean);
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    if (eq > 0 && pair.slice(0, eq).trim().startsWith("ory_session_")) return `${pair.slice(0, eq).trim()}=${pair.slice(eq + 1).trim()}`;
  }
  // A lone value with no name: assume it is the session cookie's value.
  if (pairs.length === 1 && !pairs[0].includes("=") && defaultName) return `${defaultName}=${pairs[0]}`;
  return null;
}
