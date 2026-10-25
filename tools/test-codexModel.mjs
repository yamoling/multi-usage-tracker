#!/usr/bin/env node
// Unit tests for the pure Codex usage model. Runs under plain node (no GI):
//   node tools/test-codexModel.mjs
import assert from 'node:assert/strict';
import {
    normalizeCodexWindows, normalizeResetCredits, codexCredits, codexPlanLabel, windowLengthLabel,
} from '../src/lib/codexModel.js';

let passed = 0;
const test = (name, fn) => {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
};

const NOW = Date.parse('2026-09-24T00:00:00Z');

// Shape of a real wham/usage response (identifiers removed).
const live = {
    plan_type: 'plus',
    rate_limit: {
        allowed: false,
        limit_reached: true,
        primary_window: {used_percent: 100, limit_window_seconds: 18000, reset_after_seconds: 10250, reset_at: 1790213632},
        secondary_window: {used_percent: 80, limit_window_seconds: 604800, reset_after_seconds: 155530, reset_at: 1790358912},
    },
    code_review_rate_limit: null,
    additional_rate_limits: [{
        limit_name: 'gpt-reserve',
        metered_feature: 'base_model_inference',
        rate_limit: {
            allowed: true,
            limit_reached: false,
            primary_window: {used_percent: 0, limit_window_seconds: 604800, reset_after_seconds: 604800, reset_at: 1790808182},
            secondary_window: null,
        },
    }],
    credits: {has_credits: true, unlimited: false, balance: '1450.1337260000'},
    rate_limit_reset_credits: {available_count: 1, applicable_available_count: 1},
};

test('main windows map to session + weekly with their real lengths', () => {
    const ws = normalizeCodexWindows(live, NOW);
    assert.deepEqual(ws.map(w => w.label), ['5-hour', '7-day', '7-day gpt-reserve']);
    assert.deepEqual(ws.map(w => w.role), ['session', 'weekly', 'scoped']);
    assert.equal(ws[0].utilization, 100);
    assert.equal(ws[0].totalSeconds, 18000);
    assert.equal(ws[1].totalSeconds, 604800);
    assert.equal(ws[0].resetsAt, new Date(1790213632 * 1000).toISOString());
    assert.equal(ws[0].apiLevel, 'ok');
    assert.equal(ws[0].key, 'codex:main:primary');
    assert.equal(ws[2].key, 'codex:gpt-reserve:primary');
});

test('reset_after_seconds is used when reset_at is missing', () => {
    const ws = normalizeCodexWindows({rate_limit: {primary_window: {used_percent: 5, reset_after_seconds: 60}}}, NOW);
    assert.equal(ws[0].resetsAt, new Date(NOW + 60000).toISOString());
    // No window length reported: primary defaults to 5 hours.
    assert.equal(ws[0].totalSeconds, 5 * 3600);
});

test('a weekly-only primary window sorts and labels as weekly', () => {
    const ws = normalizeCodexWindows({rate_limit: {
        primary_window: {used_percent: 30, limit_window_seconds: 604800},
        secondary_window: null,
    }}, NOW);
    assert.equal(ws.length, 1);
    assert.equal(ws[0].role, 'weekly');
    assert.equal(ws[0].label, '7-day');
});

test('utilization is clamped and non-numeric windows are dropped', () => {
    const ws = normalizeCodexWindows({rate_limit: {
        primary_window: {used_percent: 130},
        secondary_window: {used_percent: null},
    }}, NOW);
    assert.equal(ws.length, 1);
    assert.equal(ws[0].utilization, 100);
});

test('empty/garbage usage yields no windows without throwing', () => {
    assert.deepEqual(normalizeCodexWindows(null), []);
    assert.deepEqual(normalizeCodexWindows({}), []);
    assert.deepEqual(normalizeCodexWindows({additional_rate_limits: [null, {}]}), []);
});

test('windowLengthLabel names odd lengths sensibly', () => {
    assert.equal(windowLengthLabel(18000), '5-hour');
    assert.equal(windowLengthLabel(604800), '7-day');
    assert.equal(windowLengthLabel(1800), '30-minute');
    assert.equal(windowLengthLabel(undefined), 'Usage');
});

test('plan labels pass through, cased, with CODEX as the fallback', () => {
    assert.equal(codexPlanLabel('plus'), 'PLUS');
    assert.equal(codexPlanLabel('prolite'), 'PRO LITE');
    assert.equal(codexPlanLabel('self_serve_business'), 'SELF SERVE BUSINESS');
    assert.equal(codexPlanLabel(null), 'CODEX');
});

test('reset credits: count from usage, sorted expiries from the detail call', () => {
    const r = normalizeResetCredits(live, {credits: [
        {status: 'available', expires_at: '2026-10-22T20:01:48.900606Z'},
        {status: 'redeemed', expires_at: '2026-09-01T00:00:00Z'},
        {status: 'available', expires_at: 1790000000},
    ]});
    assert.equal(r.count, 1);
    assert.deepEqual(r.expiries, [new Date(1790000000 * 1000).toISOString(), '2026-10-22T20:01:48.900606Z']);
    assert.deepEqual(normalizeResetCredits(live).expiries, []);
    assert.equal(normalizeResetCredits({rate_limit_reset_credits: {available_count: 0}}), null);
    assert.equal(normalizeResetCredits({}), null);
});

test('credits: balance string, unlimited, or nothing', () => {
    assert.equal(codexCredits(live), '1450.13');
    assert.equal(codexCredits({credits: {unlimited: true}}), 'unlimited');
    assert.equal(codexCredits({credits: {has_credits: false, balance: '0'}}), null);
    assert.equal(codexCredits({}), null);
});

console.log(`\n${passed} tests passed`);
