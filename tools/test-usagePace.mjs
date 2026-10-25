#!/usr/bin/env node
import assert from "node:assert/strict";
import { scheduleFraction, paceRatio, paceRgb, nextClockMark, paceStops, DEFAULT_PACE_THRESHOLDS } from "../src/lib/usagePace.js";

// nextClockMark works on the local clock; pin the zone.
process.env.TZ = "UTC";

const now = Date.parse("2026-10-07T12:00:00Z");
const hours = (n) => n * 3600;
const resetIn = (seconds) => new Date(now + seconds * 1000).toISOString();
const rgb = (hex) => hex.match(/../g).map((v) => parseInt(v, 16) / 255);
const blue = rgb("3584e4");
const green = rgb("33d17a");
const yellow = rgb("f6d32d");
const orange = rgb("ff7800");
const red = rgb("e01b24");
const colourAt = (ratio) => paceRgb(ratio * 50, resetIn(hours(2.5)), hours(5), now);
const closeRgb = (actual, expected) =>
  actual.forEach((v, i) => {
    assert.ok(Math.abs(v - expected[i]) < 1e-12, `${actual} != ${expected}`);
  });
const blend = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
let passed = 0;
const test = (name, fn) => {
  fn();
  passed++;
  console.log(`  ok  ${name}`);
};

test("hourly and weekly markers reflect elapsed time", () => {
  assert.equal(scheduleFraction(resetIn(hours(2.5)), hours(5), now), 0.5);
  assert.equal(scheduleFraction(resetIn(hours(42)), hours(168), now), 0.75);
});
test("markers clamp to window edges", () => {
  assert.equal(scheduleFraction(resetIn(hours(6)), hours(5), now), 0);
  assert.equal(scheduleFraction(resetIn(-1), hours(5), now), 1);
});
test("invalid timing has no marker or pace colour", () => {
  for (const [reset, duration] of [
    [null, hours(5)],
    ["invalid", hours(5)],
    [resetIn(1), 0],
    [resetIn(1), NaN],
    [resetIn(1), Infinity],
  ]) {
    assert.equal(scheduleFraction(reset, duration, now), null);
    assert.equal(paceRgb(50, reset, duration, now), null);
  }
});
test("pace is usage divided by the elapsed-window budget", () => {
  assert.equal(paceRatio(25, resetIn(hours(2.5)), hours(5), now), 0.5);
  assert.equal(paceRatio(50, resetIn(hours(2.5)), hours(5), now), 1);
  assert.equal(paceRatio(75, resetIn(hours(2.5)), hours(5), now), 1.5);
});
test("0–50% pace stays blue", () => {
  for (const ratio of [0, 0.1, 0.49, 0.5]) closeRgb(colourAt(ratio), blue);
});
test("50–100% pace blends blue to green", () => {
  closeRgb(colourAt(0.75), blend(blue, green, 0.5));
  closeRgb(colourAt(0.9), blend(blue, green, 0.8));
});
test("only exactly 100% pace is pure green", () => {
  closeRgb(colourAt(1), green);
  assert.notDeepEqual(colourAt(0.99), green);
  assert.notDeepEqual(colourAt(1.01), green);
});
test("100–120% pace transitions through yellow to orange", () => {
  closeRgb(colourAt(1.05), blend(green, yellow, 0.5));
  closeRgb(colourAt(1.1), yellow);
  closeRgb(colourAt(1.15), blend(yellow, orange, 0.5));
  closeRgb(colourAt(1.2), orange);
});
test("120–150% pace blends orange to red, then stays red", () => {
  closeRgb(colourAt(1.35), blend(orange, red, 0.5));
  closeRgb(colourAt(1.5), red);
  closeRgb(colourAt(2), red);
  closeRgb(colourAt(10), red);
});
test("high utilisation can be green, while low utilisation can be red", () => {
  closeRgb(paceRgb(95, resetIn(hours(0.25)), hours(5), now), green);
  closeRgb(paceRgb(20, resetIn(hours(4.5)), hours(5), now), red);
});
test("weekly and hourly windows use the same pace colours", () => {
  closeRgb(paceRgb(50, resetIn(hours(84)), hours(168), now), green);
});
test("expired, not-started, and invalid usage have neutral colours", () => {
  assert.equal(paceRgb(50, resetIn(-1), hours(5), now), null);
  assert.equal(paceRgb(50, resetIn(hours(5)), hours(5), now), null);
  assert.equal(paceRgb(NaN, resetIn(hours(2)), hours(5), now), null);
});
test("100% usage overrides pace and unavailable reset timing", () => {
  for (const util of [100, 110]) {
    for (const [reset, duration] of [
      [resetIn(hours(0.01)), hours(5)],
      [resetIn(hours(5)), hours(5)],
      [resetIn(-1), hours(5)],
      [null, hours(5)],
      ["invalid", 0],
    ])
      closeRgb(paceRgb(util, reset, duration, now), red);
  }
  closeRgb(paceRgb(99.8, resetIn(hours(0.01)), hours(5), now), green);
});
const colourWith = (ratio, thresholds) => paceRgb(ratio * 50, resetIn(hours(2.5)), hours(5), now, thresholds);
test("default thresholds match the built-in gradient", () => {
  for (const ratio of [0.3, 0.75, 1, 1.05, 1.15, 1.35, 2]) closeRgb(colourWith(ratio, DEFAULT_PACE_THRESHOLDS), colourAt(ratio));
});
test("custom thresholds move each colour", () => {
  const t = { blue: 20, green: 50, yellow: 80, amber: 100, red: 120 };
  closeRgb(colourWith(0.2, t), blue);
  closeRgb(colourWith(0.5, t), green);
  closeRgb(colourWith(0.8, t), yellow);
  closeRgb(colourWith(1, t), orange);
  closeRgb(colourWith(1.1, t), blend(orange, red, 0.5));
  closeRgb(colourWith(1.2, t), red);
});
test("out-of-order thresholds are raised, equal ones give a hard edge", () => {
  const t = { blue: 50, green: 100, yellow: 110, amber: 100, red: 150 };
  assert.deepEqual(
    paceStops(t).map(([p]) => p),
    [0.5, 1, 1.1, 1.1, 1.5],
  );
  closeRgb(colourWith(1.1, t), yellow);
  closeRgb(colourWith(1.3, t), blend(orange, red, 0.5));
  closeRgb(colourWith(1.09, t), blend(green, yellow, 0.9));
});
test("missing or invalid thresholds fall back to defaults", () => {
  assert.deepEqual(paceStops({ blue: NaN, red: -5 }), paceStops());
});
test("at noon the next mark is 18:00 today", () => {
  // now = 12:00; 7-day window with 84 h elapsed, so 18:00 is 90 h in.
  assert.deepEqual(nextClockMark(resetIn(hours(84)), hours(168), now), { fraction: 90 / 168, hour: 18 });
});
test("in the evening the next mark is 08:00 tomorrow", () => {
  const evening = Date.parse("2026-10-07T20:00:00Z");
  const reset = new Date(evening + hours(100) * 1000).toISOString();
  assert.deepEqual(nextClockMark(reset, hours(168), evening), { fraction: 80 / 168, hour: 8 });
});
test("before 08:00 the next mark is 08:00 today", () => {
  const early = Date.parse("2026-10-07T06:00:00Z");
  assert.equal(nextClockMark(new Date(early + hours(4) * 1000).toISOString(), hours(5), early).hour, 8);
});
test("no mark when the window resets first, or timing is invalid", () => {
  assert.equal(nextClockMark(resetIn(hours(6)), hours(168), now), null);
  assert.equal(nextClockMark(resetIn(hours(6)), hours(5), now), null);
  assert.equal(nextClockMark(null, hours(168), now), null);
  assert.equal(nextClockMark(resetIn(hours(30)), 0, now), null);
});
console.log(`\n${passed} tests passed.`);
