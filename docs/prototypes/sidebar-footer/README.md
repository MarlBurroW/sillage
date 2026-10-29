# Sidebar footer proposals

Interactive design study, not a change to the application shell. All variants preserve Services,
Settings, the update indicator, and the Server account entry. Desktop removes the account entry.

- **A — Quiet toolbar:** tools on the left, account on the right; icon buttons with 120 ms tooltips.
- **B — Account first:** username on the left, icon tools on the right.
- **C — Explicit destinations:** stacked labeled destinations, then the account row.
- **Today:** optional comparison with the existing horizontal labeled footer.

The surrounding sidebar uses representative content to show the effect on session-list space.
Only footer controls are interactive; destination dialogs explain their real application behavior.
The account dialog cannot sign the user out. No production API is called.

## Design direction

Reuse the application's theme tokens and system font. The visual choice is the hierarchy of
utilities and account identity, not a new palette. Keep the session selection edge square.
The footer stays fixed while sessions scroll. Keep the update marker attached to Settings.
Avoid adding a permanent service count or connection badge without a demonstrated need.

## Preview

From the repository root, using Node 24:

```sh
node docs/prototypes/sidebar-footer/build.mjs /var/tmp/sillage-sidebar-footer-preview
```

Serve only the exported directory. The build copies current theme tokens and extracts the real
Claude and Codex marks. UI strings live in `apps/web/src/lib/i18n/prototypes/sidebar-footer`.

Controls cover light/dark themes, English/French, Server/Desktop, narrow sidebars, update indicators,
and the existing footer. Keyboard focus and touch open the same explanatory destination dialogs.

Validated with Playwright at viewport widths 320, 390, 768 and 1440; inspected desktop and phone
screenshots, checked dialogs, tooltip visibility, language/theme switches and Desktop account removal.
