# Continuity: resume, import, fork, handoff

Four features carry a conversation's history somewhere else:

- **resume**: across a process restart;
- **import**: from a session started outside Sillage;
- **fork**: onto a new branch;
- **handoff** ("Continue in another CLI…"): into another CLI.

Their implementations look CLI-specific, but they follow one rule. **The normalized journal
is the export format, and the CLI's instruction channel is the import format.** A new CLI
implements no handoff interface. It owes two things every other feature already depends
on:

- a faithful journal, for the direction CLI → Sillage;
- a reliable instruction channel, for the direction Sillage → CLI.

Native shortcuts such as native forks or Codex `thread/inject_items` are optional and sit
behind the same contract. The design is in `docs/cli-handoff.md`. The code is in
`apps/server/src/conversations/handoff.ts`, which is pure and tested in
`apps/server/test/handoff.test.ts`.

## CLI → Sillage: what the journal must hold

`collectHandoffItems` folds the journal without knowing which CLI produced it. It reads only
what is listed here, so each item is an obligation on the runner:

| Read from | Runner obligation |
|---|---|
| `message.completed` on the main thread, text blocks only | User and assistant text. Parts of one reply share a `messageId`, and the handoff merges them. Thinking blocks are not carried over. |
| `parentToolCallId` | Must be set on every subagent event. Children are skipped, because their result comes back through the spawning tool's output. A missing parent link puts subagent chatter into the transferred main thread. |
| `tool.started` (`name`, `input`) | Canonical name and the **real arguments**. The handoff ignores `tool.input_updated`, so arguments that arrive only in later updates are carried as the empty input of the start. In 20 days of production journals, about 1 % of Codex tool starts and 2 of 240 Antigravity starts had an empty input. Some of those are tools without arguments. Put the arguments in the start whenever the CLI gives them. |
| `tool.completed` (`output`, `isError`, `outputBytes`) | Output on the completion event. A body dropped from replay is announced by its size. |
| `turn.completed.stopReason` | An incomplete turn counts only if it is exactly `'interrupted'` or `'failed'`. Normalize native reasons, as Antigravity does: `end_turn`→`completed`, `cancelled`→`interrupted`. |

**User messages in the journal.**
- `SessionManager.announce` journals the user's message and opens the turn before the CLI
  even starts (the optimistic send). `send` must therefore **not** echo the message again.
- `steer` echoes it, because the platform doesn't.
- `importHistory` emits the user messages of an imported session itself.

## Sillage → CLI: how the block arrives

The handoff block is frozen in `conversation_handoffs` when the continuation is created.
It is then placed first in `projectOverview(config)` every time the runner starts
(`session-manager.ts`). It ignores the MCP and platform-addition switches, because it is
the conversation's history.

The runner's obligations:

- **Inject `projectOverview` into a channel the model reads as instructions.** This is the
  same channel as SILLAGE.md, listed per CLI in [platform.md](platform.md). Never put it in
  the first user message: the new request is the thread's first message and is never
  shortened.
- **Re-inject it on every start**: a new session, a resume after a crash or a CLI update,
  and a restart after a settings change. The exception is a CLI that saves the creation-time
  prompt with the session: Grok takes `_meta.rules` at creation only and keeps them in
  `system_prompt.txt`. Probe it: create a session, kill the process, resume, then ask the
  model about the transferred thread.
- **Check the size.** The budget goes up to 64k tokens, and Sillage counts one token per
  byte, so expect up to about 64 KB on top of SILLAGE.md, memory and the overview. Probe a
  large block and check that the CLI doesn't truncate it.
- **Keep `read_conversation` reachable.** Omitted parts are references to that Sillage MCP
  tool (`id`, `before`). If the CLI can't call MCP tools, the block still works, but its
  references are dead ends. Write that down in the coverage doc.

The route `POST /api/conversations/:id/handoff` is generic. It checks
`sessions.assertCliEnabled(target)`, resolves the target config with the target adapter's
`resolveDefaults`, and keeps the source's worktree and card. The account choice behaves as
for a new conversation. The only per-kind entry is `AGENT_NAMES` in `handoff.ts`, which the
header uses.

**A native alternative exists.** Codex `thread/inject_items` (probed on 0.162.1) adds real
user and assistant items that survive `thread/resume`. Sillage doesn't use it yet. Choose a
native path only if it is clearly better than the instruction channel and still behaves
correctly after a restart. Inject on creation only, never on resume, and keep the roles.

## Resume

- Call `setAgentSessionId` as soon as the CLI announces its id. A crash before the end of
  the first turn must still be resumable.
- Prefer resume without replay (Grok `session/resume` rather than `session/load`). Re-send
  everything the CLI doesn't persist with the session: instruction channel, MCP servers,
  skill roots (Codex sets them once per process), settings.
- Updates stop idle runners and resume them by native id (`prepareCliUpdate`). The resume
  must therefore also work after the binary changes.

## Import of native sessions (`cliSessions`)

- `importHistory` replays a native session into a new journal, without a model request.
- Antigravity sets `replaying`, emits `session.started`, then turns each user chunk into
  `endTurn`, a user `message.completed` and `turn.started`. Permission requests are
  cancelled during the replay.
- Native listing is often sparse. Antigravity has no cursor and no stable message ids. Say
  in the coverage doc whether later turns made outside Sillage are resynced
  (`resyncSessions`, Claude only, `claude/transcript-sync.ts`).

## Fork

- **Native fork.** `forkCut(log, conversationId, throughSeq)` reads native ids from the
  journal's `raw`, and `fork(target, cut)` asks the CLI to branch. Keep the ids the cut
  needs in `raw`:
  - Claude: the `uuid` of the top-level `message.completed`;
  - Codex: `turn.id` on `turn.completed`;
  - Grok: counts `turn.completed`, so an extra `turn.completed` shifts the cut.
- **Portable fork**, for a CLI without a native fork. The adapter throws `ForkError`, and
  the route builds a handoff from the source into **the same CLI**, up to the selected turn
  (`readHandoffItems(log, id, throughSeq)`). It journals the `portable_fork` notice.
  - Reasoning, attachments and native state are not copied.
  - The condition is hardcoded today (`source.agent === 'antigravity'` in
    `http/routes/conversations.ts`). Add your kind there, or better, replace the condition
    with a capability.
  - Don't trust a fork RPC that answers `{}`: Antigravity's is a stub.
- **Chains.** A branch of a continuation inherits its block.
  - `InheritedHandoff` gets at most half the budget, so repeated forks and transfers don't
    grow the instructions forever.
  - Beyond that, it shrinks to a reference to its source and cut point.

## Checkpoints

Checkpoints are server-side git snapshots and work for every CLI. A turn's checkpoint needs:

- `turn.completed` or `session.ended` to close it;
- `file.edited` to attribute files. Emit it only for successful edits.

## Verification

- **Runner tests.** Assert that `projectOverview()` reaches the native channel **at
  creation and at resume**, and never the user prompt. The existing pattern is in
  `antigravity.test.ts` (`_meta.antigravity.systemPrompt.append`), `grok-runner.test.ts`
  (`_meta.rules`) and `opencode-runner.test.ts` (`system`).
- **`handoff.test.ts`.** Fold a journal the fixture produced:
  - subagent events are skipped;
  - tool inputs and outputs are kept;
  - an interrupted turn is flagged;
  - one reply split over several `message.completed` events is merged.
- **UI check, both directions** (new CLI → Claude, Claude → new CLI; see
  `scripts/antigravity-ui-check.mjs`):
  - keep Claude enabled, because handoffs to a disabled CLI are refused;
  - read the received block back through `GET /api/conversations/:id/handoff`, which the
    "Session details" dialog uses;
  - run a fork through a chosen turn, then a transfer of that fork, to cover the inherited
    context.
- **Real trial**, modeled on the 15 October 2026 probes in `docs/cli-handoff.md`:
  - turn off the Sillage MCP server so the block is the only source, then ask the model to
    cite a specific message;
  - use a 1k budget to force a `read_conversation` call;
  - restart the target process and ask again, to check that the block survives a resume.
- **Known pitfall.** Shared project memory can contradict the transferred thread, and the
  agent once trusted the memory. The block's header says the thread wins. Keep that line if
  you change the rendering.
