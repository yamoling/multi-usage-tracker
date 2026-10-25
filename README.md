# Multi Usage Tracker

<img width="260" alt="image" align="right" src="https://github.com/user-attachments/assets/190b87b7-58cb-45f7-8782-788ca027d1b8" />

A GNOME Shell panel indicator that shows your Claude subscription tier and live
usage limits right in the top bar, so you can see how much of your 5-hour and
7-day windows you have left without opening a browser.

It reuses the OAuth token that Claude Code already stores on disk, so for most
people there is nothing to log in to. If you do not use Claude Code (or its
saved sign-in has expired), the extension can sign in on its own from the
preferences window.

> [!NOTE]
> **What changed?** See the [changelog](CHANGELOG.md) for the notable changes in each release.

See [install](#install) instructions

<br /><br />

## Features

- **Claude and Codex, side by side.** Two indicators in the top bar, each with its own popup: one for your Claude Code profiles, one for the ChatGPT account the Codex CLI is signed in to (`~/.codex/auth.json`, or `$CODEX_HOME`). The Codex popup shows the 5-hour and weekly windows, any per-model limits, your plan, credit balance, and banked rate-limit resets. Either indicator can be switched off in preferences. The Codex token is only read, never refreshed: if it lapses, run `codex` once.

- **Mistral Vibe and Muse Code too (opt-in).** Two more indicators, off by default and enabled in preferences. _Mistral Vibe_ shows the monthly Vibe Code and API allowances from [admin.mistral.ai/subscription](https://admin.mistral.ai/subscription) as a percentage and in money ("Vibe Code: €126.61 of €127.50"). _Muse Code_ shows the usage windows of the Meta account the `muse` CLI is signed in to (`~/.config/muse/auth.json`). See [Authentication](#authentication) for what each needs.

- **Panel indicator** with a Claude icon, a usage gauge (a circular ring or a horizontal bar, your choice, or none), a percentage, an optional time-until-reset countdown, and a subscription tier label. Each element can be toggled independently.
- **Multiple profiles.** If you run more than one Claude Code account on this machine (via `CLAUDE_CONFIG_DIR`, e.g. `~/.claude` and `~/.claude-work`), the extension shows every configured profile side by side in the panel and the dropdown, and refreshes them all together. Profiles are auto-detected on first run; add, rename, repoint, or remove them from the "Claude profiles" group in preferences.
- **Dropdown** with per-window meters: the 5-hour window, the 7-day window, and any per-model 7-day windows the API reports (for example Opus and Sonnet), discovered automatically.
- **Pace-aware gauges.** The ring, panel bar, and expanded usage bars share a colour scale based on usage divided by the elapsed-window budget. By default, up to 50% pace is ocean blue; 50–100% blends blue to green, with pure green at exactly 100% (on schedule); 100–120% transitions through yellow (110%) to amber; and 120–150% blends amber to red, staying red beyond that. Each of the five thresholds can be changed under "Gauge colours" in the preferences. Fill still shows actual usage in the selected window (5-hour by default for the panel). Without usable timing, gauges use a neutral theme colour. The panel percentage retains its usage/projection severity colours; captions explain predicted exhaustion (for example `burning fast — out in ~1h20m at this rate`).
- **Schedule markers.** Each expanded usage bar has a thin black vertical marker showing the elapsed fraction of its reset window: the usage you would have reached with an evenly spread budget. A fill past the marker is ahead of schedule; a fill before it leaves headroom. Markers move with the live countdown and are hidden when reset timing is unavailable.
- **Live countdown.** The "resets in" captions tick down between polls, counting in seconds once a window is less than a minute from resetting.
- **Theme aware.** The ring track follows your panel text color, so it stays legible on both light and dark themes.
- **Configurable** refresh interval and choice of which window the panel reflects (5-hour, 7-day, or whichever is most constrained).

## Requirements

- GNOME Shell 46, 47, 48, 49, or 50 (Ubuntu 24.04 LTS and newer).
- A **Claude Pro or Max subscription**. The extension reports the usage limits
  that come with a Claude Code subscription, so a free account has nothing to
  show and cannot be connected - authorization is refused before any token is
  issued, whether you sign in from the extension or from the CLI.
- Then either:
  - **Claude Code** signed in (the extension reads
    `~/.claude/.credentials.json`, or another profile directory you configure
    in preferences), or
  - an in-app sign-in via the preferences window (see Authentication below).

## Install

### From the extensions website

Install it from [extensions.gnome.org](https://extensions.gnome.org/extension/10086/claude-code-usage-monitor/) (the schema is compiled for you on install).

### From source (development)

The extension source lives in `src/`. Symlink that directory into the GNOME extensions folder:

```sh
git clone https://github.com/dvdstelt/ClaudeCodeUsage.git
cd ClaudeCodeUsage
ln -s "$PWD/src" \
  ~/.local/share/gnome-shell/extensions/multi-usage-tracker@yamoling
./tools/compile-schemas.sh
gnome-extensions enable multi-usage-tracker@yamoling
```

The extensions folder symlinks `src/`, so the code follows a branch switch
instantly, but the compiled GSettings schema is a gitignored build artifact.
If the extension fails to start with `GSettings key … not found in schema`
(e.g. after checking out a branch that adds a setting), run
`./tools/compile-schemas.sh` again.

On Wayland a newly installed extension only loads after you log out and back in.
On X11 you can reload the shell with `Alt+F2`, then `r`, then Enter.

## Configuration

Open the preferences from the dropdown (the gear button) or with:

```sh
gnome-extensions prefs multi-usage-tracker@yamoling
```

- **Panel elements** - show or hide the icon, percentage, time until reset, and tier, and choose the usage gauge (circle, bar, or none).
- **Panel reflects** - which window the ring, percentage, and time-until-reset countdown track: the 5-hour window, the 7-day window, or whichever is most constrained.
- **Panel position** - which section of the top bar the indicator sits in (left, center, or right), and where it sits among the other items there. Changes apply immediately.
- **Shortcut to open the popup** - an optional keyboard shortcut that opens the usage dropdown, the way `Super+S` opens GNOME's quick settings. Not set by default; click the row to record one, or the clear button to remove it.
- **Refresh interval** - how often to poll for updated usage (30 to 600 seconds; default 300).

## Authentication

The extension **never asks for your password**. It uses an OAuth token in one of two ways. Both require a Claude Pro or Max subscription: a free account is refused at Anthropic's authorization page, since it has no Claude Code usage limits to report.

1. **Claude Code (preferred).** If `~/.claude/.credentials.json` contains a valid token, the extension uses it directly. When the token is close to expiry it is refreshed automatically with the stored refresh token and written back to the same file, so it stays valid whether or not Claude Code itself is running. Because the credentials are shared, you stay signed in to both. If those credentials have fully expired (for example you only use Claude Desktop and never sign in to the Claude Code CLI), the extension falls back to the in-app sign-in below.
2. **In-app sign-in (fallback).** Every profile has its own **Connect** button in its row under "Claude profiles", so each profile can sign in to its own Claude account without the CLI. It runs a standard PKCE OAuth flow: Connect opens your browser, you authorize, and paste the resulting code back into the preferences window. Tokens are stored per profile in GSettings and refreshed automatically before they expire. A profile that is already signed in through Claude Code says so and needs nothing here.

**Codex** and **Muse Code** reuse their CLI's sign-in read-only (`codex login`, `muse login`). Muse Code reports no usage snapshot until the first request of a window; the popup says so instead of showing a gauge.

**Mistral Vibe** is different: the Vibe CLI's API key cannot read the plan allowances, so the indicator uses your admin.mistral.ai browser session. Sign in to admin.mistral.ai, open the developer tools (F12) → Storage (Firefox) or Application (Chrome) → Cookies, copy the value of the `ory_session_…` cookie, and paste it under "Mistral Vibe" in the preferences. The session lasts about three months; when it expires the popup asks for a new one. It is stored in GSettings in plain text, like the Claude tokens.

## Development

See `AGENTS.md` for the data sources and conventions in detail.

## Contributors

Built by [@dvdstelt](https://github.com/dvdstelt), with thanks to everyone who has contributed:

- [@amalakhovsky](https://github.com/amalakhovsky) - rendering every usage window dynamically from the API's `limits[]` array (per-model windows such as Fable, the "worst active limit" panel option, structured spend), and fixing the popup bars to fill completely at 100%.
- [@ClemDNL](https://github.com/ClemDNL) - the optional time-until-reset countdown in the panel.
- [@rafi0x](https://github.com/rafi0x) - multiple profiles

Pull requests are welcome. See `AGENTS.md` for the layout and conventions, and the [changelog](CHANGELOG.md) for what has landed so far.

## License

Released under the GNU General Public License, version 2 or later (GPL-2.0-or-later). See `LICENSE` for the full text.

## Disclaimer

This is an unofficial, community project. It is not affiliated with or endorsed by Anthropic. It relies on internal endpoints that may change at any time.
