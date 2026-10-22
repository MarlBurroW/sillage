# Session list and sidebar design study

The complete sidebar study is available at `sidebar.html`, following the user’s request to extend the selected session design. See [SIDEBAR.md](./SIDEBAR.md) for the hierarchy, scope, and interactions. The toolbar links back to the original comparisons.

Three interactive sidebar alternatives plus a reconstruction of the current layout. The same fifteen fixture sessions appear throughout, including examples of unmerged commits, a missing worktree, and unavailable Git state. Short titles are manually written examples and can be switched back to the original prompts. Dates, activity, Git states, extra sessions, and conversation excerpts are simulated; no production session is read or modified.

- Quiet list: fixed-height rows, session details in a rich hover/focus preview.
- Date: last-activity groups with excerpts.
- Worktree: sessions grouped by their worktree, with merged worktrees folded away.

Within the quiet list, aligned symbols are now the selected direction and initial view. A label below the title and a badge on the right remain available for comparison. All treatments preserve row height (47 px desktop, 48 px mobile), CLI logos, and the tooltip. Branch names remain in details. The worktree-state controls and legend are comparison aids, not proposed permanent app controls.

Worktree colors follow the existing app; uncommitted, unmerged, merged, missing, and unknown remain distinct. A main-tree session has no indicator. Merged does not imply idle, and uncommitted does not mean ready to merge.

The aligned symbols share their SVG and semantic colors with the tooltip, where a colored label and a short explanation clarify each meaning. Symbols stay in one fixed column regardless of agent activity, and also serve as the details button. Clicking them never selects another session.

The activity proposal (B) was removed after user feedback: the sidebar already has an Activity section. The user favors the quiet list (A), which is now the initial view, with a rich tooltip instead of a permanent details area. The original A/C/D labels are retained for comparison.

Select a session, expand a group, search by title or branch, change the sidebar width, and switch between comparison and conversation context. Both languages and light/dark themes are available. On phones, the context view shows the navigation drawer.

Hover for 400 ms or focus a session or its symbol with the keyboard to see its original request, CLI, latest exchange, activity, last activity, branch, and explained Git state. The preview remains open while hovered and closes with Escape, scrolling, or leaving it. Press the symbol to keep the details open with an explicit close button; touch targets are 44 px. Sessions without a worktree and the alternative treatments retain the information button. Opening details does not select the session. All lists regain the former 170 px details area.

Every session row keeps its CLI logo visible, following user feedback. The fixtures use Codex, matching the screenshot; its logo is reused from the app and labeled for assistive technology.

The study applies equally to Server and Desktop. It uses no edition-specific behavior, API, authentication, notifications, or PWA functionality. App behavior is unchanged.

## Export

With Node 24, from the repository root:

```sh
node docs/prototypes/session-list/build.mjs /var/tmp/sillage-session-list-preview
```

The build exports only the preview assets, existing theme tokens, existing agent mark, and prototype catalogs from `apps/web/src/lib/i18n/prototypes/session-list`. English defines the message keys; the French catalog is checked against them by the regular web typecheck. These catalogs are not loaded by the application.

## Preview on marldev

The private preview is served at `http://marldev.tail710c78.ts.net:7478` by the user unit `sillage-app-session-list-proposals`, with a Python server bound to loopback and a Tailscale Serve proxy. It remains available until stopped or the host reboots. The Services page can stop it; equivalent commands:

```sh
systemctl --user stop sillage-app-session-list-proposals
sudo tailscale serve --http=7478 off
```

## Verification

Typecheck, lint, and all 355 server tests pass. Browser checks cover 1440 px desktop, 390/320 px phones with real touch emulation, both languages and themes, all three proposals and the baseline, group expansion, selection, search, keyboard activation, hover retention, Escape, touch details, outside dismissal, scroll dismissal, viewport collisions, and reduced motion. Worktree-state checks also cover all three treatments, fixed row heights, every displayed state, the absence of markers on the main tree, and 264 px sidebars. Symbol checks compare actual SVGs and computed icon/label colors across the list and tooltip, verify column alignment and title clearance, and exercise direct click/focus/touch without navigation or dismissal reopening. The preview has no animation. Browser scripts (`check.mjs`, `git-check.mjs`, `symbols-check.mjs`) and screenshots are in `/var/tmp/sillage-session-list-check`.

No commit, merge, production restart, or deployment is part of this study.
