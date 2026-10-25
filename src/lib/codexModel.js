// Pure data-shaping for the Codex usage endpoint (chatgpt.com/backend-api/
// wham/usage). Produces the same normalised window shape as usageModel.js
//   {key, label, role, utilization, resetsAt, totalSeconds, apiLevel, isActive, order}
// so the popup meters, panel ring, and burn-rate colouring render Codex and
// Claude identically. No GI or shell imports: runs under plain `node`
// (tools/test-codexModel.mjs).
//
// Payload shape (undocumented, as used by the Codex CLI's /status):
//   plan_type: 'plus' | 'pro' | 'team' | ...
//   rate_limit: {primary_window, secondary_window}, each
//       {used_percent, limit_window_seconds, reset_after_seconds, reset_at (epoch s)}
//   additional_rate_limits: [{limit_name, rate_limit: {primary_window, secondary_window}}]
//   credits: {has_credits, unlimited, balance}
//   rate_limit_reset_credits: {available_count}

const FIVE_HOUR_SECONDS = 5 * 3600;
const SEVEN_DAY_SECONDS = 7 * 24 * 3600;
const DAY_SECONDS = 24 * 3600;

const ROLE_ORDER = {session: 0, weekly: 1, scoped: 2, other: 3};

// "5-hour", "7-day", or a generic length for a window the API adds later.
export function windowLengthLabel(seconds) {
    const s = Number(seconds);
    if (!Number.isFinite(s) || s <= 0)
        return 'Usage';
    if (s % DAY_SECONDS === 0)
        return `${s / DAY_SECONDS}-day`;
    if (s % 3600 === 0)
        return `${s / 3600}-hour`;
    return `${Math.round(s / 60)}-minute`;
}

// ISO reset time: the absolute reset_at when present, else now + reset_after.
function resetIso(win, nowMs) {
    const at = Number(win?.reset_at);
    if (Number.isFinite(at) && at > 0)
        return new Date(at * 1000).toISOString();
    const after = Number(win?.reset_after_seconds);
    if (Number.isFinite(after) && after >= 0)
        return new Date(nowMs + after * 1000).toISOString();
    return null;
}

function fromWindow(win, slot, scope, nowMs) {
    const used = Number(win?.used_percent);
    if (win?.used_percent == null || !Number.isFinite(used))
        return null;
    const totalSeconds = Number(win.limit_window_seconds) > 0
        ? Number(win.limit_window_seconds)
        : (slot === 'primary' ? FIVE_HOUR_SECONDS : SEVEN_DAY_SECONDS);
    const length = windowLengthLabel(totalSeconds);
    let role = totalSeconds < DAY_SECONDS ? 'session' : 'weekly';
    let label = length;
    if (scope) {
        role = 'scoped';
        label = `${length} ${scope}`;
    }
    return {
        key: `codex:${scope ?? 'main'}:${slot}`,
        label,
        role,
        utilization: Math.max(0, Math.min(100, used)),
        resetsAt: resetIso(win, nowMs),
        totalSeconds,
        apiLevel: 'ok',
        isActive: false,
        order: ROLE_ORDER[role],
    };
}

// Ordered windows: the account-wide limits first (session, then weekly), then
// any per-model limits (e.g. GPT-5.3-Codex-Spark) in API order.
export function normalizeCodexWindows(usage, nowMs = Date.now()) {
    const out = [];
    const rl = usage?.rate_limit;
    for (const slot of ['primary', 'secondary']) {
        const w = fromWindow(rl?.[`${slot}_window`], slot, null, nowMs);
        if (w)
            out.push(w);
    }
    out.sort((a, b) => a.order - b.order);

    const extra = Array.isArray(usage?.additional_rate_limits) ? usage.additional_rate_limits : [];
    extra.forEach((entry, i) => {
        const name = String(entry?.limit_name ?? entry?.metered_feature ?? '').trim() || `Limit ${i + 1}`;
        for (const slot of ['primary', 'secondary']) {
            const w = fromWindow(entry?.rate_limit?.[`${slot}_window`], slot, name, nowMs);
            if (w)
                out.push(w);
        }
    });
    return out;
}

// Plan label for the pill: the API's own token, cased, with no name mapping
// (like tierLabel for Claude) so new plans show through. "CODEX" if unknown.
export function codexPlanLabel(plan) {
    return String(plan ?? '')
        .replace(/^chatgpt[_-]?/i, '')
        .replace(/^prolite$/i, 'pro lite')
        .replace(/[_-]+/g, ' ')
        .trim()
        .toUpperCase() || 'CODEX';
}

// Banked "full reset" credits: {count, expiries: [iso, ...]} or null when none.
// resetCredits is the optional detail payload ({credits: [{status, expires_at}]}).
export function normalizeResetCredits(usage, resetCredits = null) {
    const count = Number(usage?.rate_limit_reset_credits?.available_count) || 0;
    if (count <= 0)
        return null;
    const expiries = (Array.isArray(resetCredits?.credits) ? resetCredits.credits : [])
        .filter(c => c?.status === 'available' && c.expires_at)
        .map(c => {
            const n = Number(c.expires_at);
            return Number.isFinite(n) ? new Date(n * 1000).toISOString() : String(c.expires_at);
        })
        .filter(iso => !Number.isNaN(Date.parse(iso)))
        .sort();
    return {count, expiries};
}

// Purchased credit balance as display text ("12.50", "unlimited"), or null
// when the account has none.
export function codexCredits(usage) {
    const c = usage?.credits;
    if (!c)
        return null;
    if (c.unlimited)
        return 'unlimited';
    const balance = Number(c.balance);
    if (!c.has_credits || !Number.isFinite(balance) || balance <= 0)
        return null;
    return balance.toFixed(2);
}
