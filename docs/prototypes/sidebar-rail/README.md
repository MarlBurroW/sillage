# Sidebar rail study

Standalone mockup of a two-level navigation: a rail that selects a space, and a column that lists
what the selected space contains. It answers a recurring problem: every feature added a row to a
single sidebar that served as app menu, dashboard and session list at once.

Nothing here is loaded by the app. Data is fictional (`data.js`); interface strings are French only,
since the mockup is read by one person and never shipped.

## What it shows

- **Rail**: search, Activity (badge = sessions and decisions awaiting an answer), Wall, Discussions,
  Benchmarks, pinned projects with a state dot, the full project list, Services, Settings, account.
  Pressing the current space folds its column; the rail stays.
- **Column per space**: a project keeps Board, Worktrees, Scheduled, then its sessions over the full
  height; Activity lists what awaits, what runs, unread and favorites across projects; the Wall lists
  saved views; Settings lists its sections. Services has no list, so it opens no column.
- **Phone**: the drawer carries the rail and the column side by side.
- **Study controls** (dashed panel): proposed against a reconstruction of the current sidebar, busy
  or calm data, rail with or without labels, theme, Server or Desktop. The counter reports how many
  session rows are readable without scrolling.

## Preview

```bash
node docs/prototypes/sidebar-rail/build.mjs /var/tmp/sillage-sidebar-rail-preview
```

The export copies the app's `tokens.css` and `sidebar.css` and extracts the CLI marks and logo from
their components, so rows match the real ones. `icons.js` holds the lucide icon nodes used here,
generated once from `lucide-react` (ISC).
