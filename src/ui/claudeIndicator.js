// The Claude indicator: one ProfileView per configured Claude Code profile.

import GObject from "gi://GObject";
import Gio from "gi://Gio";

import { defaultConfigDir } from "../lib/usageClient.js";
import { loadProfiles, ensureProfiles } from "../lib/profiles.js";
import { UsageIndicator } from "./indicator.js";
import { ProfileView } from "./views/claudeView.js";

export const ClaudeUsageIndicator = GObject.registerClass(
  class ClaudeUsageIndicator extends UsageIndicator {
    _init(path, settings, openPreferences, service) {
      super._init("Claude Code Usage Monitor", {
        path,
        settings,
        openPreferences,
        iconFile: `${path}/icons/claude-spark.svg`,
        usageUrl: service.usageUrl,
        // Signing in (or out) from prefs changes the token source; refetch.
        watchKeys: ["access-token"],
      });

      // Profiles were added/removed/renamed/repointed in prefs.
      this._settings.connectObject("changed::profiles", () => this._rebuildFromSettings(), this);

      this._initProfiles();
    }

    // One-time async setup: seeds the profile list (auto-detection) if it's
    // empty, then builds the views. Later profile edits go through
    // _rebuildFromSettings() instead, which is synchronous and cheap.
    async _initProfiles() {
      const cancellable = this._cancellable;
      const profiles = await ensureProfiles(this._settings);
      if (cancellable.is_cancelled()) return;
      this._buildProfileViews(profiles);
    }

    _rebuildFromSettings() {
      this._buildProfileViews(loadProfiles(this._settings));
    }

    _buildProfileViews(profiles) {
      const showChip = profiles.length > 1;
      // Only the profile the single in-app token can belong to may fall back
      // to it: the sole profile, or the one owning the default ~/.claude dir.
      const defaultDir = Gio.File.new_for_path(defaultConfigDir());
      this._setViews(() =>
        profiles.map((profile, i) => {
          const ownsDefaultDir = Gio.File.new_for_path(profile.configDir).equal(defaultDir);
          const allowSharedToken = profiles.length === 1 || ownsDefaultDir;
          return new ProfileView(
            profile,
            this._settings,
            this._panelBox,
            this._sectionsBox,
            showChip,
            i === 0,
            allowSharedToken,
            this._path,
          );
        }),
      );
    }
  },
);
