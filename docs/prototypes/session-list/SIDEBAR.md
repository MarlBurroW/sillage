# Full sidebar study

The user asked to extend the approved quiet session list and aligned Git symbols to the entire left sidebar. This remains a prototype, available at `sidebar.html`; the previous session comparisons remain at `index.html`. The application is unchanged.

## Direction

Keep Sillage's existing theme tokens and system font. Dark anchors: canvas #19161a, surface #211d22, text #f3f0f4, secondary #bdb4bf, accent #cb8dd2. Reuse semantic positive, caution, critical, and accent tokens for Git state. Titles and navigation are left aligned, 12–14 px; metadata is 10–11 px. CLI marks remain 16 px. Selected rows use a square-ended left border.

The distinctive structure is a compact global area followed by one project context, with the approved session list taking the remaining height. Avoid repeated project names, an extra permanent detail panel, or another activity-based session list.

```text
Sillage                              Hide
Search everywhere                    ⌘ K
Activity           Running / needs reply
Favorites                    Decisions
----------------------------------------
Project switcher                        ⋯
Board                   Open / to review
Worktrees              To check / merged
Scheduled                          Tasks
----------------------------------------
Sessions                        Filter +
CLI  Short title             Activity Git
CLI  Short title             Activity Git
... scrollable sessions ...
----------------------------------------
Archived                           Count
Services           Settings       Account
```

## Coverage and interactions

- Global activity retains running, awaiting-reply, and unread counts. Its dialog lists sessions by project. The compact summary avoids duplicating an expanded activity list above the full session list.
- Favorites remain global and open a short list. Pending autonomous decisions have a separate access point, shown only when needed. Their wording and pending count remain visible.
- One project switcher replaces the repeated selector/project heading. It supports search, remembering the last selected session per project, all projects, and an empty-project example. A project menu retains settings, Board, scheduling, refresh, and project creation access.
- Board, Worktrees, and Scheduled remain directly reachable. Their summaries use words and counts, not unexplained colored dots. The study's worktree count is based on distinct branch fixtures; “merged” does not imply safe cleanup.
- Session filtering is local to the selected project; global search includes projects via session metadata, titles, branches, and archives. Project-only search is in the project switcher.
- The existing session row and rich tooltip are reused, including exact Git icons/colors and direct touch/keyboard detail access without navigation. Codex and Claude marks are extracted from the existing app component. No new logo assets.
- Archived sessions open in a dedicated list without stretching the primary session scroll area. Scheduling run history is separate from ordinary sessions.
- Services and Settings stay at the bottom. Server has an account menu with a simulated logout action. Desktop has no logout or server-account menu. Both use the same navigation design.
- Clicking a session opens its sample conversation. Selecting a page clears the row's active appearance while keeping the last session in memory. Project/page navigation closes the mobile drawer; reading session details keeps it open.
- Normal-height windows scroll the session list independently. Very short windows also scroll the central context area, keeping the brand/search and bottom utilities available. The drawer can be closed and reopened on mobile; desktop supports hiding the sidebar.

Preview options change language, theme, width (264–440 px), edition, and a quiet/busy scenario. They belong to the study toolbar, outside the proposed product UI. The main pane is only enough to demonstrate navigation destinations; settings changes, creating projects/sessions, decisions, and logout are not connected to a backend.

## Deliberate scope

This study covers the hierarchy, visible entry points, overlays, keyboard/touch access, viewport behavior, and navigation. It does not implement drag ordering, persistence, mutations, automatic short titles, or a real command palette. Session rename/favorite/archive management would reuse the app's existing context menus when integrated; this prototype only demonstrates opening existing favorites and archives.

Production integration should reuse AppShell, ProjectSwitcher, SidebarActivity, SidebarSchedules, decisions hooks, existing Tooltip/Popover/Dialog primitives, conversation/worktree hooks, and edition capabilities. The plain DOM state in this study is fixture orchestration only.

## Verification

`sidebar-check.mjs` in `/var/tmp/sillage-session-list-check` exercises global activity and favorites, project switching and remembered sessions, empty/all-project views, search/filter, archives and schedule access, exclusive selection, fixed utility placement, width/collapse, identical Git colors, Server/Desktop differences, French/English, light/dark, 1440×1000 desktop and 390×844 / 320×568 touch viewports. The earlier tooltip and symbol checks still pass. Typecheck, lint, and 355 tests pass.
