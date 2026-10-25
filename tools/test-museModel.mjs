#!/usr/bin/env node
// Unit tests for the pure Muse Code model. Runs under plain node (no GI):
//   node tools/test-museModel.mjs
import assert from "node:assert/strict";
import { normalizeMuseWindows, musePlanLabel } from "../src/lib/museModel.js";

let passed = 0;
const test = (name, fn) => {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
};

// Real key response without a usage snapshot (identifiers removed).
const noUsage = {
  is_subs_active: true,
  subs_tier_name: "Muse Code Everyday Usage",
  user_full_name: "Ada Lovelace",
  subs_usage: null,
};

test("no snapshot gives no windows", () => {
  assert.deepEqual(normalizeMuseWindows(noUsage), []);
  assert.deepEqual(normalizeMuseWindows(null), []);
});

test("snake_case snapshot with epoch-second resets", () => {
  const w = normalizeMuseWindows({
    ...noUsage,
    subs_usage: {
      window: { used_percent: 42.5, window_duration_mins: 300, resets_at: 1792972800 },
      weekly: { used_percent: 120, resets_at: 1793404800 },
    },
  });
  assert.deepEqual(
    w.map((x) => [x.key, x.role, x.label]),
    [
      ["muse:window", "session", "5-hour"],
      ["muse:weekly", "weekly", "Weekly"],
    ],
  );
  assert.equal(w[0].utilization, 42.5);
  assert.equal(w[0].totalSeconds, 300 * 60);
  assert.equal(w[0].resetsAt, "2026-10-26T00:00:00.000Z");
  assert.equal(w[1].utilization, 100); // clamped
  assert.equal(w[1].totalSeconds, 7 * 24 * 3600);
});

test("camelCase snapshot (CLI --json shape) with ms and ISO resets", () => {
  const w = normalizeMuseWindows({
    allowance: {
      window: { usedPercent: 10, windowDurationMins: 1440, resetsAtMs: 1792972800000 },
      weekly: { usedPercent: 5, resetsAt: "2026-10-31T00:00:00Z" },
    },
  });
  assert.equal(w[0].label, "1-day");
  assert.equal(w[0].role, "weekly"); // a day or longer is not a session window
  assert.equal(w[0].resetsAt, "2026-10-26T00:00:00.000Z");
  assert.equal(w[1].resetsAt, "2026-10-31T00:00:00.000Z");
});

test("plan label drops the product prefix", () => {
  assert.equal(musePlanLabel(noUsage), "EVERYDAY USAGE");
  assert.equal(musePlanLabel({}), "MUSE");
});

console.log(`${passed} passed`);
