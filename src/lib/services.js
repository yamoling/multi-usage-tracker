// The services the extension can show, in panel order. One entry per top-bar
// indicator; extension.js maps each id to its indicator, and prefs builds the
// on/off switches and shortcut rows from the same list. No imports, so both
// the shell and prefs can use it.
//
//   id          stable identifier; also the panel role suffix (`<uuid>-<id>`,
//               except Claude, which keeps the bare uuid it always had)
//   title       human name
//   showKey     boolean GSettings key that adds/removes the indicator
//   shortcutKey `as` GSettings key bound to open its popup
//   usageUrl    page opened by the popup's "Usage page" button
//   subtitle    one-line description for prefs

export const SERVICES = Object.freeze([
  {
    id: "claude",
    title: "Claude",
    showKey: "show-claude",
    shortcutKey: "toggle-menu",
    usageUrl: "https://claude.ai/settings/usage",
    subtitle: "Usage of your Claude Code profiles.",
  },
  {
    id: "codex",
    title: "Codex",
    showKey: "show-codex",
    shortcutKey: "toggle-codex-menu",
    usageUrl: "https://chatgpt.com/codex/settings/usage",
    subtitle: "Usage of the ChatGPT account the Codex CLI is signed in to.",
  },
  {
    id: "vibe",
    title: "Mistral Vibe",
    showKey: "show-vibe",
    shortcutKey: "toggle-vibe-menu",
    usageUrl: "https://admin.mistral.ai/subscription",
    subtitle: "Monthly Vibe Code and API allowances of your Mistral plan.",
  },
  {
    id: "muse",
    title: "Muse Code",
    showKey: "show-muse",
    shortcutKey: "toggle-muse-menu",
    usageUrl: "https://accountscenter.meta.com/muse_code/",
    subtitle: "Usage of the Meta account the Muse Code CLI is signed in to.",
  },
]);

// Panel role for a service's indicator.
export function serviceRole(uuid, service) {
  return service.id === "claude" ? uuid : `${uuid}-${service.id}`;
}
