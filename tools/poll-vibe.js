#!/usr/bin/env -S gjs -m
// Standalone check: validates the Mistral Vibe client against the live site.
//   gjs -m tools/poll-vibe.js                 (cookie from the extension's GSettings)
//   gjs -m tools/poll-vibe.js <cookie-file>   (file holding the ory_session cookie)
import GLib from "gi://GLib";
import Gio from "gi://Gio";
import { VibeClient } from "../src/lib/vibeClient.js";
import { normalizeVibeWindows, vibeSpendLines, vibePlanLabel } from "../src/lib/vibeModel.js";

const loop = GLib.MainLoop.new(null, false);
const arg = typeof ARGV !== "undefined" ? ARGV[0] : undefined;

function settings() {
  const source = Gio.SettingsSchemaSource.new_from_directory("src/schemas", Gio.SettingsSchemaSource.get_default(), false);
  return new Gio.Settings({ settings_schema: source.lookup("org.gnome.shell.extensions.claude-usage", false) });
}

async function run() {
  const client = arg
    ? new VibeClient({ cookie: new TextDecoder().decode(GLib.file_get_contents(arg)[1]).trim() })
    : new VibeClient({ settings: settings() });
  const [budget, session] = await Promise.all([client.fetchBudget(), client.fetchSession()]);
  print("plan:", vibePlanLabel(session));
  print("\nwindows (normalised):");
  for (const w of normalizeVibeWindows(budget)) print(`  ${w.label}: ${w.utilization.toFixed(2)}%  resets ${w.resetsAt}`);
  print("");
  for (const line of vibeSpendLines(budget)) print(line);
}

run()
  .catch((e) => {
    printerr("ERROR:", e.message);
    imports.system.exit(1);
  })
  .finally(() => loop.quit());

loop.run();
