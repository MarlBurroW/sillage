# SILLAGE.md: shared instructions for Claude, Codex, OpenCode, and Grok Build

Instructions managed by Sillage and injected into every session's system prompt,
regardless of its CLI: a **global** section (administrators) and a **project** section
(owner). Editable from the project page, settings (`/settings/consignes`), and a
conversation's header without using the file editor.

## Where project instructions live

Each project has a mode chosen at creation (`instructionsMode`), which can change later:

- **`sillage`**: text is stored in the database (`instructions` table) and injected
  into every CLI. Workspace and worktree `CLAUDE.md`, `CLAUDE.local.md`, and
  `AGENTS.md` files are hidden from agents without touching them on disk: leaving
  them readable would duplicate instructions.
- **`repo`**: the project section is the repository's `AGENTS.md` (or `CLAUDE.md`),
  which CLIs read themselves. The interface edits that file directly, defaulting
  to `AGENTS.md`. Sillage injects only the global section.

Without a choice at creation, the server inspects the directory: `repo` if it
already contains one of these files, `sillage` otherwise. Projects predating the
setting have no mode (null) and keep this dynamically resolved behavior; the first
write of Sillage content fixes their mode to `sillage`, so a later `AGENTS.md`
does not silence it.

Migrating an existing project is offered only in its instructions panel: one
button imports repository files' text and switches to `sillage` mode. Files stay
in the repository; switching back to `repo` reactivates them.

## What the probes established

Probed on 2026-10-05 with Claude Code 2.1.286 and codex-cli 0.157.1.

- Claude Code reads root `AGENTS.md` like `CLAUDE.md`.
- The `claudeMdExcludes` setting (settings flag) hides both. Patterns must be scoped
  to the directory: `**/CLAUDE.md` without a root would also hide `~/.claude/CLAUDE.md`.
- For Codex, `project_doc_max_bytes = 0` disables project `AGENTS.md` files;
  the one in `CODEX_HOME` is still read.

Probed on 2026-10-05 with opencode 1.18.25.

- OpenCode reads the project's `AGENTS.md`, falling back to its `CLAUDE.md`.
- `OPENCODE_DISABLE_PROJECT_CONFIG=1` disables both. It is the only switch: it also
  disables the project's `opencode.json` and `.opencode/` directory. Instructions
  use each message's `system` field.

Probed on 2026-10-17 with Grok Build 1.0.62.

- Grok reads `AGENTS.md`, `Agents.md`, `AGENT.md`, `CLAUDE.md`, and `Claude.md` in every
  directory between the repository root and working directory, plus those in
  `~/.grok` and `~/.claude` until `GROK_CLAUDE_AGENTS_ENABLED` is disabled (Sillage
  always disables it).
- The only switch is the agent profile: `_meta.agentProfile` with `agentsMd: false`
  at session creation and resume. It removes only the browser-verification
  paragraph from the system prompt.
- Instructions use `session/new`'s `_meta.rules`, appended to the system prompt in
  a `<human_rules>` block. ACP's `systemPrompt` field and the `--rules` option are
  ignored by `grok agent`.

## Agents can write to it

The `sillage` MCP server treats SILLAGE.md as a file: `read_instructions` reads it,
`edit_instructions` replaces an exact passage (like Edit, with empty `old_text`
to append), and `write_instructions` rewrites it entirely. Project section only
in `sillage` mode; global section writable from an administrator's conversation.
Every write runs in a transaction on the current version, and the interface shows
who last edited it (person or session). In `repo` mode, tools point agents to the
repository file, which they edit with their own tools.

## When changes take effect

At session launch for Claude and Codex. Claude records its system prompt on the
first exchange and replays it unchanged on resume: an already open session keeps
the received version until its next compaction. OpenCode receives instructions
with each message and sees changes on the next one. Grok Build receives them at
session creation and keeps them for its lifetime: resume rereads the saved system
prompt. The mode itself is read when the runner launches.

## Giving agents remotely accessible links

If the browser is on another device, preview links must use the VPN name of the
machine running the agents. The
[remote-access guide](remote-access.md#teach-agents-to-share-reachable-preview-links)
provides a template to adapt in global or project instructions: actual machine
name, allowed ports, HTTPS, verification, and cleanup. These instructions guide
agents; they do not configure the VPN themselves.

## Acceptance checks

`apps/server/test/instructions.test.ts` covers routes, modes, migration, and the MCP
tool. Checks with real CLIs ran on a disposable server (`/tmp/smd-e2e`, port 7402):
9 out of 9 passed, covering global and project injection, hiding in `sillage` mode,
unchanged `repo` mode, and an instruction saved by Claude reaching the next Codex session.

# Project memory

Alongside instructions, which are rules given to agents, memory is what they retain
themselves: a `MEMORY.md` index and one note per file, in Claude Code's automatic
memory format. One directory per project, `<data>/memory/projects/<id>`, shared by
all CLIs and all project worktrees.

- **Claude** receives this directory through `autoMemoryDirectory` (settings flag)
  and uses it as native memory: it loads the index at startup and writes notes
  without requesting permission, even in default mode. Nothing is written to
  `~/.claude/projects/<directory>/memory` anymore.
- **Codex** has no equivalent (its `memories` feature extracts memories from past
  threads in the background). It receives the index and directory path in its
  developer instructions, reads notes with `cat`, and writes through the MCP tools
  `read_memory`, `write_memory`, and `delete_memory`, since its sandbox cannot write
  outside the workspace. `write_memory` adds a new note's index entry automatically.
- **OpenCode** is handled like Codex: the index and directory path arrive with every
  message in its system prompt, and it writes through the same MCP tools.
- **Grok Build** too, except the index arrives once, in session creation `rules`.
  Its own cross-session memory (`~/.grok/memory-v2`) is untouched.
- **Interface**: a “Memory” card on the project page lists notes, opens them for
  editing, and deletes them along with their index entries.
- **Native mode** (`memoryMode = 'native'`, set on the Memory card): Sillage no
  longer manages a directory for this project. Claude keeps its usual memory in
  `~/.claude` per working directory; Codex, OpenCode, and Grok keep their own.
  No index is injected, and memory MCP tools are not advertised. The default for
  future projects, like the instruction-mode default, is an account setting
  (`projectDefaults`) set by the first-run tour.

At first launch, the memory Claude kept for the workspace root is copied into the
still-empty directory once (recorded in `.imported-from.json`). The original stays
in place. Worktree memory, which Claude stored by directory, is not imported.

Probed on 2026-10-05 with Claude Code 2.1.286: `autoMemoryDirectory` redirects reads
and writes, with nothing written to the default directory. Checks with real CLIs:
8 out of 8 passed, covering import, a Claude write read by Codex, and a Codex write
(`write_memory`) read by Claude.
