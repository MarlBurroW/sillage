# Activity hierarchy

The session title becomes the primary reading level; the project stays visible
below each title. The sidebar directly shows the first four active sessions,
waiting ones first, then access to the full list. Global collapse remains available.

In the global view, sections distinguish requests needing input, ongoing work,
and turn completions. Status aligns right on desktop and joins the project below
the title on phones. Selection uses a neutral background and edge line to avoid
competing with waiting states. Colors and font remain those of the Sillage theme.

Checks: `NODE_ENV=development pnpm typecheck`, `NODE_ENV=development pnpm test`
(142 tests), `NODE_ENV=development pnpm lint`,
`NODE_ENV=development node scripts/activity-ui-check.mjs`.

Playwright uses a temporary database and simulated statuses: waiting priority,
direct access, collapse, filters, turn completions, background, errors, adding a
session, focus restoration, no horizontal overflow. Screenshots at 1440 × 900
and 390 × 844, with dark and light themes for the global view. No CLI started or
production restart.

- [Sidebar](activity-expanded.png)
- [Dark global view](activity-overview.png)
- [Light global view](activity-overview-light.png)
- [Mobile navigation](activity-mobile.png)
- [Mobile global view](activity-overview-mobile.png)
