import Meta from "gi://Meta";
import Shell from "gi://Shell";

import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as Main from "resource:///org/gnome/shell/ui/main.js";

import { SERVICES, serviceRole } from "./lib/services.js";
import { VIBE_COOKIE_KEY } from "./lib/vibeClient.js";
import { UsageIndicator } from "./ui/indicator.js";
import { ClaudeUsageIndicator } from "./ui/claudeIndicator.js";
import { CodexView } from "./ui/views/codexView.js";
import { VibeView } from "./ui/views/vibeView.js";
import { MuseView } from "./ui/views/museView.js";

// A single-account indicator whose only view is built by `View`.
function singleViewIndicator(name, iconFile, View, extra = {}) {
  return (path, settings, openPreferences, service) =>
    new UsageIndicator(name, {
      path,
      settings,
      openPreferences,
      iconFile: `${path}/icons/${iconFile}`,
      usageUrl: service.usageUrl,
      buildViews: (ind) => [new View(settings, ind.panelBox, ind.sectionsBox, path)],
      ...extra,
    });
}

// How to build each service's indicator, keyed by the ids in lib/services.js.
const INDICATORS = {
  claude: (path, settings, openPreferences, service) => new ClaudeUsageIndicator(path, settings, openPreferences, service),
  codex: singleViewIndicator("Codex Usage Monitor", "codex.png", CodexView),
  // A new pasted session in prefs should show up right away.
  vibe: singleViewIndicator("Mistral Vibe Usage Monitor", "vibe.svg", VibeView, { watchKeys: [VIBE_COOKIE_KEY] }),
  muse: singleViewIndicator("Muse Code Usage Monitor", "muse.svg", MuseView),
};

export default class ClaudeUsageExtension extends Extension {
  /** @ai-edited */
  enable() {
    this._settings = this.getSettings();
    // service id -> indicator, for the services currently shown.
    this._indicators = new Map();
    // Watch the placement and per-service keys so changes apply
    // immediately, with no reload and no logging out.
    this._settings.connectObject(
      "changed::panel-position",
      () => this._place(),
      "changed::panel-index",
      () => this._place(),
      ...SERVICES.flatMap((s) => [`changed::${s.showKey}`, () => this._syncIndicators()]),
      this,
    );
    this._syncIndicators();

    // Optional shortcuts that open each popup, the same as clicking the
    // indicator — the shell binds its own panel menus this way (Super+S
    // for quick settings). Unbound by default, so nothing is taken from
    // the user until they choose a combination. Meta follows the GSettings
    // keys themselves, so changing a shortcut needs no extra plumbing.
    // POPUP matters: while a dropdown is open the shell is in popup mode,
    // and a binding without it goes silent — so the shortcut could open
    // the menu but never close it again.
    const modes = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP;
    for (const service of SERVICES) {
      Main.wm.addKeybinding(service.shortcutKey, this._settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT, modes, () =>
        this._indicators.get(service.id)?.menu.toggle(),
      );
    }
  }

  // Creates or destroys each service's indicator to match its show-* key,
  // then re-places whatever is left.
  /** @ai-edited */
  _syncIndicators() {
    for (const service of SERVICES) {
      const want = this._settings.get_boolean(service.showKey);
      const have = this._indicators.get(service.id);
      if (want && !have) {
        const create = INDICATORS[service.id];
        this._indicators.set(
          service.id,
          create(this.path, this._settings, () => this.openPreferences(), service),
        );
      } else if (!want && have) {
        have.destroy();
        this._indicators.delete(service.id);
      }
    }
    this._place();
  }

  // Puts the indicators side by side in the configured panel box, in the
  // order of SERVICES. addToStatusArea refuses a role that is already
  // registered, so the registrations are cleared first; the indicators
  // themselves are reused, so moving them costs no refetch and leaves the
  // poll timers and current readings alone.
  /** @ai-edited */
  _place() {
    for (const service of SERVICES) {
      const role = serviceRole(this.uuid, service);
      if (Main.panel.statusArea[role]) Main.panel.statusArea[role] = null;
    }
    const box = this._settings.get_string("panel-position");
    let index = this._settings.get_int("panel-index");
    for (const service of SERVICES) {
      const indicator = this._indicators.get(service.id);
      if (indicator) Main.panel.addToStatusArea(serviceRole(this.uuid, service), indicator, index++, box);
    }
  }

  /** @ai-edited */
  disable() {
    for (const service of SERVICES) Main.wm.removeKeybinding(service.shortcutKey);
    this._settings?.disconnectObject(this);
    this._settings = null;
    for (const indicator of this._indicators?.values() ?? []) indicator.destroy();
    this._indicators?.clear();
    this._indicators = null;
  }
}
