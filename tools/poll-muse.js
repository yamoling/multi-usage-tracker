#!/usr/bin/env -S gjs -m
// Standalone check: validates the Muse Code client against the live API.
//   gjs -m tools/poll-muse.js           (uses $XDG_CONFIG_HOME/muse)
//   gjs -m tools/poll-muse.js --raw     (also dumps the usage snapshot)
import GLib from "gi://GLib";
import { MuseClient } from "../src/lib/museClient.js";
import { normalizeMuseWindows, musePlanLabel } from "../src/lib/museModel.js";

const loop = GLib.MainLoop.new(null, false);
const raw = typeof ARGV !== "undefined" && ARGV.includes("--raw");

async function run() {
  const info = await new MuseClient().fetchUsage();
  print("plan:", musePlanLabel(info), "| active:", info.is_subs_active);
  // Never print the whole record: it carries the account's API key.
  if (raw) print("\nraw subs_usage:", JSON.stringify(info.subs_usage ?? null, null, 2));
  const windows = normalizeMuseWindows(info);
  print("\nwindows (normalised):");
  if (!windows.length) print("  (none reported yet for this window)");
  for (const w of windows) print(`  ${w.label} [${w.role}]: ${Math.round(w.utilization)}%  resets ${w.resetsAt ?? "(n/a)"}`);
}

run()
  .catch((e) => {
    printerr("ERROR:", e.message);
    imports.system.exit(1);
  })
  .finally(() => loop.quit());

loop.run();
