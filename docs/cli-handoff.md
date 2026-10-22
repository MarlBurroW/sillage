# Continue a conversation in another CLI

From a conversation, “Continue in another CLI…” (the header's `…` menu) opens a new
conversation with Claude Code, Codex, opencode, or Grok Build that picks up the thread
where it stands. The model is T3 Code's “portable handoffs”: a **budgeted selection of
history**, with full texts, in order, and with their roles, rather than an agent-written
summary.

## What the new agent receives

A block injected into the CLI's instruction channel, the same one as SILLAGE.md: the
system prompt for Claude (`systemPrompt.append`), the thread's `developerInstructions`
for Codex, each message's `system` for opencode, and the session creation `rules` for
Grok Build. It stays there for the conversation's lifetime, like an ordinary thread's
history, and is read again whenever the CLI starts because it otherwise loses it on
resume (Grok keeps it in the system prompt saved with the session).

The block contains, in selection priority order:

1. **the original request**, the user's first message;
2. **the latest exchanges**, working backward from the end without skipping messages,
   so the window remains a readable thread; interrupted turns are identified so the
   preceding work is understood to be partial;
3. **tool calls within this window**, most recent first, with input truncated to
   400 characters and output to 1,200.

Anything that does not fit is replaced with a reference:

```
[14 message(s) omis ici, du message 4 au message 120. Pour les relire :
read_conversation avec id="…" et before=121, puis remonter avec la valeur de
`before` que l'outil annonce.]
```

`read_conversation` is the Sillage MCP server tool that returns a project's
conversation messages from the user and agent in chunks. The cited numbers are
journal `seq` values, which are what the tool expects.

Reasoning, tool state, and attachments are not transferred. **The new request is
not included**: it is written in the continuation's composer, never shortened,
and becomes the thread's first message.

## Budget

16k tokens by default, from 1k to 64k, chosen in the dialog. The count is conservative,
**one token per byte**: this overestimates normal text by a factor of three to four,
so the handoff fits regardless of the target model's tokenizer. The reference is
counted before messages because it is what remains when nothing else fits; the
block header is a fixed cost outside the budget. If even the original request
does not fit, the handoff fails (`handoff_too_large`) instead of sending it truncated.

## Where it lives

- `apps/server/src/conversations/handoff.ts`: folds the journal into items
  (`collectHandoffItems`), selects them (`selectHandoff`), and renders them
  (`renderHandoff`). Pure and tested (`apps/server/test/handoff.test.ts`). Selection
  reads the normalized journal and does not know which CLI produced the thread.
- `POST /api/conversations/:id/handoff` (`agent`, `config`, `budgetTokens?`) creates the
  continuation in the same worktree and on the same card;
  `GET /api/conversations/:id/handoff` returns the transmitted block, shown by the
  “Session details” dialog.
- `conversation_handoffs` table: the block frozen at creation, just as a fork freezes
  the journal. `conversations.handoff_from_id` records the relationship, shown as a
  chip linking to the source in the header. A branch of a continuation inherits its block.
- Injection happens in `session-manager.ts`, at the start of the `projectOverview`
  parts, without a toggle: this is the thread's history, not extra Sillage context.

## What the probes established

Probed on 2026-10-15 with codex-cli 0.162.1, Claude Code 2.1.296, and opencode 1.18.34.

- Codex exposes `thread/inject_items` (snake_case; `thread/injectItems` is rejected),
  which adds raw Responses API items to the model-visible history. Injected `user`
  and `assistant` messages are read by the model on the next turn **and survive
  `thread/resume` in a new app-server**. This is the path T3 Code uses. Sillage does
  not use it yet: the instruction channel works the same for all three CLIs and can
  be replayed at every start without persistence concerns. Moving Codex to
  `inject_items` would require keeping the structured selection (roles) and injecting
  only on `thread/start`, never on `thread/resume`.
- Real handoffs on a disposable server with new projects: Claude → Codex and
  Codex → Claude with Sillage's MCP server disabled so the injected block is the only
  source (Claude cites “message 74 of the transferred thread”); Claude → Codex with a
  message too long for a 1k budget, where Codex calls `read_conversation` with the
  reference's `id` and `before` and retrieves what was missing.
- Observed pitfall: project memory (`memory/`) is shared across CLIs and can
  contradict the transmitted block when an earlier session wrote something else;
  the agent initially preferred memory. The header now says the continued thread
  takes precedence and contradictions should be reported.
