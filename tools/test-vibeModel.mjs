#!/usr/bin/env node
// Unit tests for the pure Mistral Vibe model. Runs under plain node (no GI):
//   node tools/test-vibeModel.mjs
import assert from "node:assert/strict";
import {
  normalizeVibeWindows,
  vibeSpendLines,
  vibePlanLabel,
  vibeAccountName,
  unwrapTrpc,
  parseSessionCookie,
  monthSecondsEndingAt,
} from "../src/lib/vibeModel.js";

let passed = 0;
const test = (name, fn) => {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
};

// Shape of a real billing.budget payload (2026-10-25).
const budget = {
  usage_percentage: 1.36,
  initial_budget: 12.75,
  currency: "EUR",
  reset_at: "2026-11-01T00:00:00Z",
  api_budget: { usage_percentage: 1.36, initial_budget: 12.75, currency: "EUR", reset_at: "2026-11-01T00:00:00Z" },
  vibe_budget: { usage_percentage: 99.30323547333333, initial_budget: 127.5, currency: "EUR", reset_at: "2026-11-01T00:00:00Z" },
};

test("vibe allowance first, then API, both monthly", () => {
  const w = normalizeVibeWindows(budget);
  assert.deepEqual(
    w.map((x) => x.key),
    ["vibe:code", "vibe:api"],
  );
  assert.equal(w[0].role, "monthly");
  assert.ok(Math.abs(w[0].utilization - 99.303) < 0.001);
  assert.equal(w[0].resetsAt, "2026-11-01T00:00:00.000Z");
  assert.equal(w[0].totalSeconds, 31 * 24 * 3600); // October has 31 days
});

test("zero budgets are skipped", () => {
  const w = normalizeVibeWindows({ ...budget, vibe_budget: { ...budget.vibe_budget, initial_budget: 0 } });
  assert.deepEqual(
    w.map((x) => x.key),
    ["vibe:api"],
  );
});

test("flat legacy payload falls back to the API budget", () => {
  const w = normalizeVibeWindows({ usage_percentage: 50, initial_budget: 10, currency: "EUR", reset_at: "2026-11-01T00:00:00Z" });
  assert.equal(w.length, 1);
  assert.equal(w[0].key, "vibe:api");
});

test("month length follows the calendar", () => {
  assert.equal(monthSecondsEndingAt("2026-03-01T00:00:00Z"), 28 * 24 * 3600);
  assert.equal(monthSecondsEndingAt("garbage"), null);
});

test("spend lines derive the spent amount", () => {
  assert.deepEqual(vibeSpendLines(budget), ["Vibe Code: €126.61 of €127.50", "API: €0.17 of €12.75"]);
});

test("plan label and account name", () => {
  const session = { name: "Ada Lovelace", organization: { active_chat_plan: "EDU", has_vibe_pro: true } };
  assert.equal(vibePlanLabel(session), "EDU");
  assert.equal(vibePlanLabel({ organization: { active_chat_plan: "INDIVIDUAL" } }), "PRO");
  assert.equal(vibePlanLabel({}), "VIBE");
  assert.equal(vibeAccountName(session), "Ada Lovelace");
  assert.equal(vibeAccountName({ first_name: "Ada", last_name: "L" }), "Ada L");
});

test("tRPC unwrap tells a result from a login flow", () => {
  assert.deepEqual(unwrapTrpc({ result: { data: { json: { a: 1 } } } }), { a: 1 });
  assert.equal(unwrapTrpc({ id: "flow", type: "browser", ui: {} }), undefined);
});

test("session cookie parsing", () => {
  const def = "ory_session_x";
  assert.equal(parseSessionCookie("abc", def), "ory_session_x=abc");
  assert.equal(parseSessionCookie("ory_session_y=abc", def), "ory_session_y=abc");
  assert.equal(parseSessionCookie("Cookie: csrftoken=1; ory_session_z=a=b; __cf_bm=2", def), "ory_session_z=a=b");
  assert.equal(parseSessionCookie("csrftoken=1; other=2", def), null);
  assert.equal(parseSessionCookie("  ", def), null);
});

console.log(`${passed} passed`);
