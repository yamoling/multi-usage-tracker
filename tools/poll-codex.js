#!/usr/bin/env -S gjs -m
// Standalone check: validates the Codex client against the live API.
//   gjs -m tools/poll-codex.js              (uses $CODEX_HOME or ~/.codex)
//   gjs -m tools/poll-codex.js ~/.codex-work
//   gjs -m tools/poll-codex.js --raw        (also dumps the raw payload shape)
import GLib from 'gi://GLib';
import {CodexClient, defaultCodexHome} from '../src/lib/codexClient.js';
import {normalizeCodexWindows, normalizeResetCredits, codexCredits, codexPlanLabel} from '../src/lib/codexModel.js';

const loop = GLib.MainLoop.new(null, false);
const args = typeof ARGV !== 'undefined' ? [...ARGV] : [];
const raw = args.includes('--raw');
const dirArg = args.find(a => a !== '--raw');

function resolveDir(arg) {
    if (!arg)
        return defaultCodexHome();
    if (arg.startsWith('~/'))
        return GLib.build_filenamev([GLib.get_home_dir(), arg.slice(2)]);
    if (GLib.path_is_absolute(arg))
        return arg;
    return GLib.build_filenamev([GLib.get_current_dir(), arg]);
}

// Replace identifiers with a placeholder so --raw output is safe to share.
function redact(value) {
    if (Array.isArray(value))
        return value.map(redact);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([k, v]) =>
            [k, /email|user_id|account_id|^id$/i.test(k) && v ? '<redacted>' : redact(v)]));
    }
    return value;
}

async function run() {
    const codexHome = resolveDir(dirArg);
    const client = new CodexClient({codexHome});
    print('codex home:', codexHome);

    const {usage, resetCredits, account} = await client.fetchUsage();
    print('plan:', codexPlanLabel(usage.plan_type ?? account.plan), '| signed in:', account.email ? 'yes (email present)' : 'yes');
    if (raw) {
        print('\nraw usage:', JSON.stringify(redact(usage), null, 2));
        if (resetCredits)
            print('\nraw reset credits:', JSON.stringify(redact(resetCredits), null, 2));
    }

    print('\nusage windows (normalised):');
    for (const w of normalizeCodexWindows(usage))
        print(`  ${w.label} [${w.role}]: ${Math.round(w.utilization)}%  resets ${w.resetsAt ?? '(n/a)'}`);

    const resets = normalizeResetCredits(usage, resetCredits);
    if (resets)
        print(`\nbanked resets: ${resets.count}  expiries: ${resets.expiries.join(', ') || '(n/a)'}`);
    const credits = codexCredits(usage);
    if (credits)
        print(`credits: ${credits}`);
}

run()
    .catch(e => {
        printerr('ERROR:', e.message);
        if (e.body)
            printerr('BODY:', e.body.slice(0, 500));
        imports.system.exit(1);
    })
    .finally(() => loop.quit());

loop.run();
