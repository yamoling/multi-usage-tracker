# Multi Usage Tracker (GNOME Shell extension)

GNOME Shell panel indicators, one per service (Claude, Codex, Mistral Vibe,
Muse Code), that show your subscription tier and live usage limits. The Codex
indicator reads the ChatGPT sign-in the Codex CLI keeps in
`$CODEX_HOME/auth.json` (default `~/.codex`), and the Muse Code one the sign-in
in `$XDG_CONFIG_HOME/muse/auth.json`, both read-only. Mistral Vibe uses a
pasted admin.mistral.ai session cookie (see Data sources). Everything below
about tokens and profiles is Claude-specific. It reuses the OAuth token that Claude
Code already stores on disk, so there is usually no separate login. Each profile
can also sign in on its own, from a PKCE flow in its row in prefs, for accounts
that never use the CLI.

## Layout

The shipped extension lives in `src/`; everything else (this file, the README,
the LICENSE, `build.sh`, `tools/`) is repo tooling that stays out of the bundle.

Each service is three layers, so adding one touches a known set of files:

| Layer          | Pure?      | Claude                   | Codex                   | Mistral Vibe           | Muse Code              |
| -------------- | ---------- | ------------------------ | ----------------------- | ---------------------- | ---------------------- |
| client (fetch) | GI only    | `lib/usageClient.js`     | `lib/codexClient.js`    | `lib/vibeClient.js`    | `lib/museClient.js`    |
| model (shape)  | no imports | `lib/usageModel.js`      | `lib/codexModel.js`     | `lib/vibeModel.js`     | `lib/museModel.js`     |
| view (render)  | shell      | `ui/views/claudeView.js` | `ui/views/codexView.js` | `ui/views/vibeView.js` | `ui/views/museView.js` |

To add a service: write the three files, add an entry to `lib/services.js`
and to `INDICATORS` in `extension.js`, add the `show-<id>` and
`toggle-<id>-menu` schema keys, an icon, and a `cu-pill-<id>` style; prefs
picks the switch and shortcut rows up from `SERVICES`.

- `src/extension.js` — entry point only: creates/destroys one indicator per
  enabled service (`SERVICES` order, panel role `<uuid>` for Claude and
  `<uuid>-<id>` for the others), places them side by side, and binds each
  service's popup shortcut.
- `src/lib/services.js` — the service registry (id, title, `show-*` and
  shortcut keys, usage page URL), shared by the extension and prefs.
- `src/ui/indicator.js` — `UsageIndicator`, one panel button with its own
  popup, poll timer, and countdown, showing one or more views. Views are built
  by a `buildViews` callback; `watchKeys` lists settings whose change forces a
  refetch. Replacing the views cancels any refresh still in flight for the old
  ones (`_viewsCancellable`).
- `src/ui/claudeIndicator.js` — `ClaudeUsageIndicator`, one `ProfileView` per
  configured Claude Code profile, rebuilt when `profiles` changes.
- `src/ui/usageView.js` — `UsageView`, one usage source's panel block and popup
  section (meters, ring/bar, error and signed-out states). Failure wording is
  configuration (`messages: {expired, forbidden, rateLimited, unreachable}`),
  not an override. The panel shows the service icon once, then one block per
  view (ring/bar, percentage, reset countdown, tier label), each toggleable via
  GSettings. A small chip (e.g. "TE") tags each Claude block only when more
  than one profile is configured.
- `src/ui/widgets.js` — `Meter`, `Ring`, `PanelBar` (each with a `destroy()`
  following the teardown rules below).
- `src/lib/format.js` — pure severity/projection/countdown helpers.
- `src/lib/windows.js` — the normalised window shape every model produces
  (roles `session`/`weekly`/`monthly`/`scoped`/`other`), and timestamp/percent
  helpers.
- `src/lib/errors.js` — `UsageError`, `SignedOutError` (re-exported by
  `usageClient.js` for older importers). `src/lib/http.js` — `requestJson()`
  over libsoup and async `loadJsonFile()`, used by every client.
- `src/prefs.js` — Adwaita preferences (element toggles, panel window, refresh
  interval, the "Claude profiles" list), bound to GSettings. Each profile row
  carries its own PKCE sign-in (`_addSignInRows`): a status line that reads
  "Using Claude Code", "Connected", or "Not connected", plus Connect, a field
  for the pasted code, and Disconnect.
- `src/schemas/` — GSettings schema (`org.gnome.shell.extensions.claude-usage`).
  Keys: `show-claude`/`show-codex`/`show-vibe`/`show-muse` (bool, one
  indicator each; Vibe and Muse default off),
  `vibe-session-cookie` (string, the pasted admin.mistral.ai session),
  `toggle-vibe-menu`/`toggle-muse-menu` (`as`, popup shortcuts),
  `show-icon`/`show-percentage`/`show-tier`/`show-reset` (bool, apply to all),
  `panel-gauge` (`ring`|`bar`|`none`),
  `panel-window` (`five-hour`|`seven-day`|`max`|`worst`), `poll-seconds` (30-600),
  `panel-position` (`left`|`center`|`right`) + `panel-index` (0-20, where the
  indicator sits in that box; applied live by re-registering it in `_place()`),
  `toggle-menu` (`as`, keyboard shortcut that opens the popup; empty = unbound,
  registered with `Main.wm.addKeybinding` like the shell's own panel menus),
  `toggle-codex-menu` (`as`, the same for the Codex popup),
  `profiles` (JSON string, array of `{id, label, configDir}`),
  `profile-tokens` (JSON string, profile id -> in-app tokens),
  `show-profile-chip` (bool),
  `show-clock-mark` (bool, a labelled dent on each popup bar at the next
  08:00 or 18:00 local, hidden if the window resets first; position from
  `nextClockMark()` in `lib/usagePace.js`, drawn by `UsageBar`),
  `pace-blue`/`pace-green`/`pace-yellow`/`pace-amber`/`pace-red`
  (int 0-200, the pace in % of the evenly spread budget at which
  each gauge colour is reached in full; key names in `PACE_THRESHOLD_KEYS`,
  gradient built by `paceStops()` in `lib/usagePace.js`, edited in prefs by
  the draggable gradient scale in `lib/paceScale.js`),
  `profiles-initialized` (bool, set once auto-detection has seeded `profiles`
  so a deliberately-emptied list isn't re-seeded), and the in-app sign-in
  tokens `access-token`/`refresh-token` (string) + `expires-at` (int64 ms).
  Recompile after edits: `glib-compile-schemas src/schemas/`.
- `src/lib/usageClient.js` — pure GI module: resolves a token for a given
  `configDir` (that profile's on-disk credentials first, the extension's own
  GSettings tokens second), calls the usage and profile endpoints, refreshes the
  token when near expiry, and writes it back to whichever store it came from.
  Takes a `profileId` and resolves that profile's own in-app token from
  `tokenStore.js` when the on-disk credentials are missing or dead; a profile
  that has never signed in resolves to a `SignedOutError`, which the panel shows
  as a muted "Signed out" state. `allowSharedToken` now only decides which
  single profile may claim a pre-per-profile sign-in during migration. Exports
  `claudeCodeCredentialsAvailable(configDir)`, `defaultConfigDir()`
  (`~/.claude`), and `discoverConfigDirs()` (finds `~/.claude` and sibling
  `~/.claude-*` directories that already hold credentials).
- `src/lib/profiles.js` — the profile list: `loadProfiles`/`saveProfiles`
  (JSON in the `profiles` GSettings key) and `ensureProfiles` (seeds the list
  from `discoverConfigDirs()` once, gated by `profiles-initialized`). Kept
  shell-import-free like `usageClient.js` so prefs and plain `gjs` can use it
  too.
- `src/lib/tokenStore.js` — per-profile in-app OAuth tokens, kept as a JSON
  object in the `profile-tokens` GSettings key keyed by profile id. Each
  profile signs in to its own Claude account; `migrateLegacyToken()` moves a
  pre-per-profile single sign-in onto the one profile entitled to it. No
  imports at all, so it is unit-testable under plain `node`
  (`tools/test-tokenStore.mjs`).
- `src/lib/paceScale.js` — prefs-only GTK widget: a 0-200% pace scale painted
  with the gauge gradient and one draggable cursor per `pace-*` threshold
  (cursors can't cross; arrow keys nudge). No shell imports, so a plain `gjs`
  script can render it.
- `src/lib/oauth.js` — shared OAuth/API constants (client id, endpoints,
  scopes, headers) and text codecs, imported by both `usageClient.js` and
  `prefs.js` so the values are defined once. No shell imports.
- `src/lib/usageModel.js` — pure data-shaping: turns the usage payload into the
  ordered list of windows the popup renders (`normalizeWindows`, preferring the
  self-describing `limits[]` array and falling back to the legacy flat keys) and
  the extra-usage money block (`normalizeSpend`). No GI or shell imports, so it
  is unit-testable under plain `node` (see `tools/test-usageModel.mjs`).
- `src/lib/codexClient.js` — pure GI Codex client: reads
  `$CODEX_HOME/auth.json` (async), calls `GET chatgpt.com/backend-api/wham/usage`
  (headers `Authorization`, `ChatGPT-Account-Id`, `User-Agent: codex-cli`) and,
  only when resets are banked, `.../wham/rate-limit-reset-credits`. Never
  refreshes or writes the token: the CLI rotates its refresh token, and a
  second writer could sign it out. A 401 tells the user to run `codex`.
- `src/lib/codexModel.js` — pure data-shaping for the Codex payload, producing
  the same window shape as `usageModel.js` (so meters, ring, and burn-rate
  colours are shared), plus plan label, credits, and banked resets. Tested by
  `node tools/test-codexModel.mjs`; `gjs -m tools/poll-codex.js [--raw]` checks
  the live API (`--raw` dumps the payload with identifiers redacted).
- `src/lib/vibeClient.js` / `src/lib/vibeModel.js` — Mistral Vibe (see Data
  sources). Tested by `node tools/test-vibeModel.mjs`; `gjs -m
tools/poll-vibe.js [cookie-file]` checks the live site.
- `src/lib/museClient.js` / `src/lib/museModel.js` — Muse Code (see Data
  sources). Tested by `node tools/test-museModel.mjs`; `gjs -m
tools/poll-muse.js [--raw]` checks the live API (`--raw` prints only
  `subs_usage`, never the record, which contains an API key).
- `src/stylesheet.css` — `cu-*` classes for the indicator and popup.
- `src/icons/` — panel icon (`claude-spark.svg`) and popup logo
  (`octopus.png`); `codex.png` is the Codex icon for both.
- `build.sh` — runs `gnome-extensions pack src` into `dist/`, including `lib`,
  `icons`, and the schema; excludes dev files. Output is the uploadable
  `dist/<uuid>.shell-extension.zip`. Accepts an optional `-major`/`-minor`/
  `-patch` flag that bumps `version-name` (semver) in `metadata.json` and
  increments the integer `version` before packing.
- `tools/poll.js` — standalone validator that hits the live API and prints the
  normalised windows + spend, run from the repo root: `gjs -m tools/poll.js`
  (defaults to `~/.claude`) or `gjs -m tools/poll.js ~/.claude-work` to check a
  specific profile.
- `tools/test-usageModel.mjs` — pure-`node` unit tests for `usageModel.js`
  (no network, no GI): `node tools/test-usageModel.mjs`.
- `tools/compile-schemas.sh` — recompiles the GSettings schema for a
  development install, and fails loudly if a key in the XML is missing from the
  result. A no-op when the compiled file is already current.

## Data sources

- Tier: `~/.claude/.credentials.json` (`claudeAiOauth.subscriptionType` /
  `rateLimitTier`), confirmed via `GET https://api.anthropic.com/api/oauth/profile`.
- Limits: `GET https://api.anthropic.com/api/oauth/usage`. The current shape is
  a self-describing `limits[]` array — each entry has `kind`
  (`session`/`weekly_all`/`weekly_scoped`), `group` (`session`/`weekly`),
  `percent`, `severity` (`normal`/`warning`/`critical`), `resets_at`,
  `is_active`, and an optional `scope.model.display_name` naming a per-model
  window (e.g. Fable). Money now comes as a structured `spend` object
  (`used`/`limit` as `{amount_minor, currency, exponent}` + `percent` +
  `severity`). The older flat keys (`five_hour`, `seven_day`,
  `seven_day_<model>` with `utilization` %, plus `extra_usage`) are still parsed
  as a fallback in `usageModel.js`. Required headers:
  `Authorization: Bearer <token>`, `anthropic-beta: oauth-2025-04-20`,
  `anthropic-version: 2023-06-01`.
- Refresh: `POST https://platform.claude.com/v1/oauth/token` with
  `grant_type=refresh_token` and the public Claude Code `client_id`.

- Mistral Vibe: the CLI's own credential (a Mistral API key in the keyring)
  only reaches `GET console.mistral.ai/api/vibe/whoami` (plan, no usage). The
  allowances come from admin.mistral.ai's tRPC routes, authenticated with the
  site's Ory browser session cookie (`ory_session_…`, ~3-month lifetime):
  `GET admin.mistral.ai/api/local-trpc/billing.budget?input=<superjson null>`
  returns `{result: {data: {json: {api_budget, vibe_budget}}}}`, each budget
  `{usage_percentage, initial_budget, currency, reset_at}` (reset on the 1st
  of the month); `user.meSession` gives the name and
  `organization.active_chat_plan`. A bad session gets HTTP 200 with an Ory
  login-flow object instead of a tRPC result, which the client maps to 401.
  An API key, with or without the session, is rejected.
- Muse Code: `POST api.meta.ai/muse-code/key` with body `{"onboard": false}`,
  headers `Authorization: Bearer <access_token from auth.json>` and
  `x-api-version: 1.0.0` (what `muse usage` sends). The response carries
  `is_subs_active`, `subs_tier_name`, `user_full_name`, an API key (never log
  it), and `subs_usage`, which is `null` until the first request of a window.
  Its shape (`window: {used_percent, window_duration_mins, resets_at}`,
  `weekly: {used_percent, resets_at}`) comes from strings in the CLI binary
  and has not yet been seen live, so `museModel.js` is lenient about spelling
  and timestamp units. A blocked request answers 429 with `resets_at` (epoch
  s).

These are undocumented internal endpoints and may change without notice.

## Conventions

- All file I/O must stay cheap and non-blocking; never parse large transcripts on
  the shell main loop (it janks the compositor). Network calls use libsoup async,
  and file reads/writes use the `_async` GIO variants — the review tooling
  rejects synchronous `load_contents()` / `replace_contents()` in shell code.
- Keep `src/lib/usageClient.js` and `src/lib/usageModel.js` free of
  `resource:///org/gnome/shell` imports so they stay runnable under plain `gjs`
  (both are also imported by `prefs.js` or the tools).

### Never pin a GI version

Import GI libraries unversioned — `import Soup from 'gi://Soup'`, never
`gi://Soup?version=3.0`, and no `imports.gi.versions` module either. Reviewers
have asked for this twice now: once to delete a `lib/versions.js` that set
`imports.gi.versions.Soup`, and again (rejecting 1.4.1) for the inline
`?version=` spelling of the same thing. It is _not_ in the written review
guidelines, so it will not show up in the checklist — it comes from the human
reviewer.

The reason it matters: a pin is an assertion, not a preference. If the host
process has already loaded another version, the import is a fatal error —
`Error: Version 3.0 of GI module Soup already loaded, cannot load version 2.4`.
GNOME Shell loads libsoup itself, so a pin can only match (redundant) or
mismatch (breaks the extension outright on some future GNOME release). There is
no upside inside the shell.

The tempting reason to add one: on a machine with both the Soup 2.4 and 3.0
typelibs, plain `gjs` warns "Requiring Soup but it has 2 versions available".
That warning only appears in standalone `gjs` (i.e. `tools/poll.js`), where
nothing has preloaded Soup, and it is harmless — GJS still resolves to 3.0.
Inside the shell and prefs processes Soup 3 is already loaded. Do not "fix" it
with a pin.

### Teardown rules

extensions.gnome.org runs a static analysis (Shexli) on every upload, and it
checks these mechanically. Getting them wrong fails review, so:

- **Connect signals with `connectObject(..., this)`, never a bare `connect()`**,
  and drop them with a single `disconnectObject(this)` during teardown. A raw
  `connect()` stored on a `this.*` field with no matching disconnect is flagged
  (EGO-L-003). Disconnect _before_ destroying the actors, so nothing fires
  mid-teardown.
- **Destroy every object you create, explicitly.** Call `.destroy()` on each
  child widget (leaf-first, then the container) rather than relying on the
  parent to cascade — the analyser matches each `this._x = new St.…` against a
  corresponding `this._x.destroy()` and cannot infer cascading (EGO-L-002).
- **Null the references afterwards** (`this._x = null`), and null the indicator
  in `disable()` (EGO-L-005). Prefer this over a `this._destroyed` flag; guard
  late async callbacks with a `Gio.Cancellable` that teardown cancels.

Helper classes that own widgets (`Meter`, `PanelBar`) therefore each expose a
`destroy()` that follows all three rules; call it from the indicator's
`destroy()`.

## Install (development)

Symlink `src/` (not the repo root) into the extensions folder:

```sh
ln -s "$PWD/src" ~/.local/share/gnome-shell/extensions/multi-usage-tracker@yamoling
./tools/compile-schemas.sh
gnome-extensions enable multi-usage-tracker@yamoling
```

On Wayland a new extension only loads after logging out and back in.

The extensions folder symlinks `src/`, so the code follows every branch switch
instantly, but `gschemas.compiled` is a gitignored build artifact that nothing
regenerates automatically. Checking out a branch that adds a GSettings key then
leaves the shell reading a stale schema, and the extension dies at startup with
`GSettings key <name> not found in schema …`. Run `./tools/compile-schemas.sh`
by hand to fix it; that error message always means "recompile", never a code
fault.

## Release

`./build.sh` packs `src/` into `dist/<uuid>.shell-extension.zip` for upload to
extensions.gnome.org. The bundle contains only runtime files.
