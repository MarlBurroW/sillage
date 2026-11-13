# Moving a session between projects

The conversation toolbar's **Move to another project** action corrects sessions started in
the wrong project. Project agents have `list_projects` and `move_session({ project })`
for the same operation. The agent should identify a mismatch, obtain the intended project
from the user, request the move, and finish its turn.

The session keeps its Sillage ID, title, full journal, attachments, bookmarks and read
positions. Its old URL follows the ID to the destination. The conversation owner can move
it into any accessible, non-archived project, including a shared project owned by someone
else. Administrators cannot move someone else's conversation. Personal discussions,
scheduled runs and benchmark runs retain their existing workflows.

Active turns, questions, startup and detached work finish before the move. Pending moves
are stored in `conversation_project_moves` and recovered after daemon restarts. Queued
messages are delivered in the destination after the move.

The native runner stops, and its native session ID is cleared. The next message starts a
new native thread in the destination directory, with its instructions, memory, skills and
MCP configuration. CLI/model/account choices stay with the conversation. The agent receives
a bounded selection of original messages (the existing portable handoff algorithm, 64,000
conservatively counted tokens); the entire original journal and attachment paths remain
readable through `read_conversation`. This deliberately avoids resuming native transcripts
tied to the old working directory. Forks use portable context after a move.

Files and project memory are not moved or copied automatically. Existing absolute image
links can still read the previous directory and linked worktrees while the viewer retains
access to the previous project. The old card and worktree association are detached. Old
checkpoints cannot restore files in the new project. Editor fingerprints include the file's
absolute location so an old draft cannot silently overwrite a same-named destination file.

Server and Desktop use the same service and routes. Desktop remains single-account,
loopback-only, and uses its normal launcher handshake without a login page.

Validation:

- `NODE_ENV=development pnpm typecheck`
- `NODE_ENV=development pnpm test`
- `NODE_ENV=development pnpm lint`
- `NODE_ENV=production pnpm --filter @sillage/web build`
- `NODE_ENV=development node --import ./apps/server/node_modules/tsx/dist/loader.mjs scripts/project-transfer-ui-check.mjs`

The browser check starts disposable Server and Desktop instances, with every CLI disabled,
and checks the real toolbar, project selector, move API, navigation, history and old images
at 1440 and 390 pixels. Set `TRANSFER_SHOTS` to keep screenshots outside the disposable data.

