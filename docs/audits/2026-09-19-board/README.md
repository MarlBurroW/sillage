# Board and ticket editing

The board offers text/number search, complete ticket creation, columns with colored
markers, and more readable cards. On mobile, search selects a column containing a
result. Keyboard movement stays available; it is disabled during search to avoid
reordering a partial list.

The detail view is wider and separates Details, Activity, and Sessions. The editor
labels its fields, provides a Markdown preview, and keeps save actions visible.
Drafts stay in the tab. Ctrl/Cmd + Enter saves; launching a new session requires
saving changes first.

Attachments are added after ticket creation through multiple selection or drop.
They save immediately, independently of the description draft. Images have thumbnails;
files have view/download links. The limit is 20 MB per file. Agents retrieve name,
type, size, and local path through `read_card`. Files follow project visibility.

## Storage and installation

Migration `0025_eager_zarek.sql` adds `attachments.card_id` and its index. It applies
at server startup. Ticket files are excluded from abandoned-upload cleanup and
cannot be reassigned to a chat message. Deleting a ticket or project removes its
files; the `ON DELETE SET NULL` foreign key also leaves files eligible for cleanup
in direct SQL deletions. Local paths are reserved for the agent tool, not the web API.

## Verification

- `pnpm typecheck` and `pnpm build`: passed.
- `pnpm test`: 37 tests passed, including upload, limits, permissions, cleanup, and real MCP reads.
- `pnpm test:board-ui`: creation, drafts, preview, save shortcut, multiple attachments,
  drop, reading, failure/retry, deletion, search, keyboard sorting, mobile.
- `pnpm test:ui`: full suite passed, including concurrent saves, keyboard navigation,
  and no overflow from 320 to 1440 pixels.

Screenshots in this directory are produced by `scripts/board-ui-check.mjs` on a
temporary database with agents disabled. Build warnings about `::highlight` and
bundle size predated this redesign.

## Temporary preview

A separate demo instance with fictitious data and disabled agents runs for 24 hours
under user unit `sillage-board-preview`. It is exposed only through Tailscale on
port 7620. Demo sign-in: `alex` / `sillage-demo`. The main instance was not redeployed.

To close this preview:

```sh
systemctl --user stop sillage-board-preview
sudo tailscale serve --http=7620 off
```
