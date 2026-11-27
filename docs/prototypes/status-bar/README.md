# Status bar study

Mockup of a customizable status line under the composer, replacing today's fixed row (CLI, warm
or cold session, "connected", shortcut reminder). Nothing here is loaded by the app. Data is
fictional (`data.ts`); interface strings are French only, since the mockup is read by one person.

Unlike the earlier static prototypes, this one is React rendered by the web app's own Vite,
React and Tailwind: it imports `apps/web/src/styles/index.css` and real components (`AgentIcon`,
`IconButton`, `Tooltip`, `Segmented`, `Switch`, `ContextMeter`). The conversation page around the
bar (`Stage.tsx`) is a static copy using the classes of `ConversationHeader`, `MessageBubble` and
`Composer`.

## What it shows

- **One layout per account, shared by every CLI.** An item a CLI does not report hides in its
  sessions; the quota adapts by showing the windows each CLI reports (busiest one, or all).
- **Formats per item**: bar, ring or text for proportions (quota, context). Phones fold bars into
  rings.
- **One line at every width**: items show in the user's order while they fit, the rest goes behind
  "+N". The shortcut reminder is the first to go and never counts in "+N". On a phone the whole
  line opens a sheet listing everything.
- **Settings dialog**: a single sortable list (drag handle, switch, format, quota option) and a
  preview with a CLI picker, so the user sees what each CLI will display.
- Putting "Context" in the bar removes the composer's context gauge.

Which CLI reports what was read from the adapters (`apps/server/src/agents`), not probed on the
binaries: check before implementing.

## Preview

```bash
node docs/prototypes/status-bar/serve.mjs   # PORT=7502 by default, 127.0.0.1 only
node docs/prototypes/status-bar/check.mjs   # screenshots in /var/tmp/sillage-status-bar-check
```

`serve.mjs` links this folder's `node_modules` to `apps/web/node_modules` (ignored by Git), so
bare imports and Vite's pre-bundling find the app's packages.
