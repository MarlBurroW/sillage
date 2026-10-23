import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ContentBlock, SillageEvent } from '@sillage/protocol'
import { toWorkspacePath } from '../paths.js'
import { editedPath } from './file-edits.js'
import { TranscriptReader } from './transcript-reader.js'

/**
 * Read/translate Claude Code session transcripts.
 *
 * CLI saves JSONL under `$CLAUDE_CONFIG_DIR/projects/<cwd-slug>/<sessionId>.jsonl`. Importing
 * externally started sessions reconstructs journal from this file (I2: only display source),
 * matching live ClaudeRunner.translate.
 *
 * Not a copy: CLI still rereads full file on resume, Sillage derives display only. `raw` retains
 * entries including uuid for later fork cuts (I3).
 */

/**
 * Provenance of disk-transcript raw payloads versus live SDK stream: same shapes today, sources may
 * diverge.
 */
export const TRANSCRIPT_RAW_FORMAT = 'claude-transcript@1'

/** Journal input for one translated entry. */
export interface TranslatedEvent {
  ts: number
  event: SillageEvent
  raw?: unknown
}

export interface TranscriptEntry {
  type?: unknown
  subtype?: unknown
  uuid?: unknown
  timestamp?: unknown
  isSidechain?: unknown
  isMeta?: unknown
  isCompactSummary?: unknown
  message?: { id?: unknown; model?: unknown; content?: unknown }
  toolUseResult?: { type?: unknown; agentId?: unknown }
  compactMetadata?: { trigger?: unknown; preTokens?: unknown; postTokens?: unknown }
}

/**
 * CLI session-file location: each nonalphanumeric cwd character becomes hyphen. SDK provides
 * listSessions/getSessionInfo but no transcript reader, hence this resolution.
 */
export function transcriptPath(cwd: string, sessionId: string): string {
  const configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  return join(configDir, 'projects', slug, `${sessionId}.jsonl`)
}

/** Transcript entries, or empty list if file absent. */
export function readTranscript(cwd: string, sessionId: string): Promise<TranscriptEntry[]> {
  return readJsonl(transcriptPath(cwd, sessionId))
}

async function readJsonl(path: string): Promise<TranscriptEntry[]> {
  const reader = await TranscriptReader.open(path)
  if (!reader) return []
  try {
    const entries: TranscriptEntry[] = []
    for await (const { entry } of reader.lines(0, await reader.prefix(0))) if (entry) entries.push(entry)
    return entries
  } finally { await reader.file.close() }
}

/**
 * Session subagent threads indexed by launching call.
 *
 * CLI writes separate `<sessionId>/subagents/agent-<agentId>.jsonl` without original call; main
 * transcript Task result carries agentId link. Without reading these, resync loses all subagent
 * work.
 */
export async function readSubAgentTranscripts(
  cwd: string,
  sessionId: string,
  entries: TranscriptEntry[],
): Promise<Map<string, TranscriptEntry[]>> {
  const dir = join(transcriptPath(cwd, sessionId).replace(/\.jsonl$/, ''), 'subagents')
  const threads = new Map<string, TranscriptEntry[]>()

  // Subagents may spawn others, calls appearing only in first child file: recursively discover from
  // every read thread until none remain.
  let frontier = entries
  while (frontier.length > 0) {
    const found: TranscriptEntry[] = []
    for (const [agentId, toolCallId] of spawnedAgents(frontier)) {
      if (threads.has(toolCallId)) continue
      const parsed = await readJsonl(join(dir, `agent-${agentId}.jsonl`))
      // Still-running subagents or older CLIs may leave no file; rest of import does not depend on
      // it.
      if (parsed.length === 0) continue
      threads.set(toolCallId, parsed)
      found.push(...parsed)
    }
    frontier = found
  }

  return threads
}

/**
 * Spawned subagents mapped from agentId to launching call.
 *
 * Entry carries agentId, blocks carry call ID: grouped results cannot identify which spawned
 * subagent. No link beats random linkage making whole thread silently invisible.
 */
export function spawnedAgents(entries: TranscriptEntry[]): Map<string, string> {
  const spawned = new Map<string, string>()
  for (const entry of entries) {
    const agentId = entry.toolUseResult?.agentId
    if (typeof agentId !== 'string') continue
    const content = entry.message?.content
    if (!Array.isArray(content)) continue

    const results = (content as Record<string, unknown>[]).filter(
      (block) => block.type === 'tool_result' && typeof block.tool_use_id === 'string',
    )
    const only = results.length === 1 ? results[0] : undefined
    if (only) spawned.set(agentId, only.tool_use_id as string)
  }
  return spawned
}

export function entryTs(entry: TranscriptEntry): number {
  const parsed = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
  return Number.isFinite(parsed) ? parsed : Date.now()
}

/**
 * Local `/compact`, `/model` commands are stored as tagged user messages: commands to CLI, not
 * agent speech.
 */
function isLocalCommand(text: string): boolean {
  return text.startsWith('<command-') || text.startsWith('<local-command-')
}

/**
 * CLI interruption markers: `[Request interrupted by user]` and `[Request interrupted by user for
 * tool use]`.
 *
 * Transcript stores user messages nobody wrote: interruption traces. Replaying literally displayed
 * fake user speech each interruption.
 *
 * Anchored both ends: messages discussing markers remain genuine messages.
 */
const INTERRUPT_MARKER = /^\[Request interrupted by user[^\]]*\]$/

interface ToolUse {
  path: string | null
  startedAt: number
}

export interface TranscriptTranslationState {
  pendingTools: [string, ToolUse][]
  model: string | null
  inTurn: boolean
  count: number
}

/**
 * Translate transcript entries into journal events.
 *
 * Mirrors ClaudeRunner.translate except persisted format: turn boundaries from system/turn_duration
 * (stream result not written), no token totals because transcript lacks per-turn counts.
 *
 * `sidechains` holds call-indexed subagent threads. Merge events by timestamp: separate CLI files
 * belong to same main journal.
 */
export function translateTranscript(
  entries: TranscriptEntry[],
  cwd: string,
  sidechains: Map<string, TranscriptEntry[]> = new Map(),
): { events: TranslatedEvent[]; model: string | null } {
  const main = translateThread(entries, cwd, null)
  if (sidechains.size === 0) return main

  const events = [...main.events]
  for (const [toolCallId, sideEntries] of sidechains) {
    events.push(...translateThread(sideEntries, cwd, toolCallId).events)
  }

  // Stable sort preserves each thread’s equal-timestamp order; transcript millisecond resolution
  // cannot distinguish them.
  const order = new Map(events.map((event, index) => [event, index]))
  events.sort((a, b) => a.ts - b.ts || (order.get(a) ?? 0) - (order.get(b) ?? 0))

  return { events, model: main.model }
}

/**
 * Exactly one thread: main (null thread) or subagent.
 *
 * Only main owns turn boundaries/compactions: subagents work inside turns, never open them.
 */
export function transcriptTranslator(cwd: string, thread: string | null, saved?: TranscriptTranslationState) {
  const pendingTools = new Map<string, ToolUse>(saved?.pendingTools)
  let model: string | null = saved?.model ?? null
  let inTurn = saved?.inTurn ?? false
  let count = saved?.count ?? 0

  const snapshot = (): TranscriptTranslationState => ({ pendingTools: [...pendingTools], model, inTurn, count })
  const push = (entry: TranscriptEntry): TranslatedEvent[] => {
    const events: TranslatedEvent[] = []
    // Older CLIs mark inline subagent turns this way. Treating as main would show subagent prompts
    // as user speech.
    if (thread === null && entry.isSidechain === true) return events
    const ts = entryTs(entry)

    if (entry.type === 'assistant') {
      const message = entry.message
      if (!message || !Array.isArray(message.content)) return events
      if (typeof message.model === 'string' && message.model !== '<synthetic>') {
        model = message.model
      }

      const blocks: ContentBlock[] = []
      for (const block of message.content as Record<string, unknown>[]) {
        if (block.type === 'text' && typeof block.text === 'string') {
          blocks.push({ type: 'text', text: block.text })
        } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
          blocks.push({ type: 'thinking', text: block.thinking })
        } else if (block.type === 'tool_use' && typeof block.id === 'string') {
          const name = typeof block.name === 'string' ? block.name : ''
          pendingTools.set(block.id, { path: editedPath(name, block.input), startedAt: ts })
          blocks.push({ type: 'tool_use', toolCallId: block.id, name, input: block.input })
          events.push({
            ts,
            event: {
              type: 'tool.started',
              toolCallId: block.id,
              name,
              input: block.input,
              parentToolCallId: thread,
            },
            raw: block,
          })
        }
      }

      if (blocks.length > 0 && typeof message.id === 'string') {
        events.push({
          ts,
          event: {
            type: 'message.completed',
            messageId: message.id,
            role: 'assistant',
            blocks,
            parentToolCallId: thread,
          },
          raw: entry,
        })
      }
      return events
    }

    if (entry.type === 'user') {
      if (entry.isMeta === true || entry.isCompactSummary === true) return events
      const content = entry.message?.content

      if (Array.isArray(content)) {
        let handled = false
        for (const block of content as Record<string, unknown>[]) {
          if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
          handled = true
          const started = pendingTools.get(block.tool_use_id)
          pendingTools.delete(block.tool_use_id)

          const isError = block.is_error === true
          events.push({
            ts,
            event: {
              type: 'tool.completed',
              toolCallId: block.tool_use_id,
              output: block.content ?? null,
              isError,
              durationMs: started ? Math.max(ts - started.startedAt, 0) : 0,
            },
            raw: block,
          })

          const path = started && !isError ? started.path : null
          if (path !== null) {
            events.push({
              ts,
              event: {
                type: 'file.edited',
                toolCallId: block.tool_use_id,
                path: toWorkspacePath(cwd, path),
                // Previous existence no longer observable: saved CLI result identifies creation.
                action: entry.toolUseResult?.type === 'create' ? 'created' : 'modified',
              },
            })
          }
        }
        if (handled) return events
      }

      const text =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? (content as Record<string, unknown>[])
                .filter((block) => block.type === 'text' && typeof block.text === 'string')
                .map((block) => block.text as string)
                .join('\n')
            : ''
      if (!text.trim() || isLocalCommand(text) || INTERRUPT_MARKER.test(text.trim())) return events

      // Subagents work inside parent turn; opening their own would flicker main activity.
      if (!inTurn && thread === null) {
        events.push({ ts, event: { type: 'turn.started' } })
        inTurn = true
      }
      events.push({
        ts,
        event: {
          type: 'message.completed',
          messageId: typeof entry.uuid === 'string' ? entry.uuid : `import-${count + events.length}`,
          role: 'user',
          blocks: [{ type: 'text', text }],
          parentToolCallId: thread,
        },
        raw: entry,
      })
      return events
    }

    if (entry.type === 'system' && thread === null) {
      // No inTurn condition: resync may begin mid-turn whose start is already journaled; closure
      // must pass.
      if (entry.subtype === 'turn_duration') {
        // Transcript lacks per-turn costs/tokens: imported counters start zero instead of invented
        // figures.
        events.push({
          ts,
          event: {
            type: 'turn.completed',
            stopReason: 'imported',
            costUsd: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
          },
        })
        inTurn = false
      } else if (entry.subtype === 'compact_boundary') {
        const meta = entry.compactMetadata
        events.push({
          ts,
          event: {
            type: 'context.compacted',
            trigger: meta?.trigger === 'manual' || meta?.trigger === 'auto' ? meta.trigger : 'unknown',
            preTokens: typeof meta?.preTokens === 'number' ? meta.preTokens : null,
            postTokens: typeof meta?.postTokens === 'number' ? meta.postTokens : null,
          },
          raw: entry,
        })
      }
    }
    // Everything else (mode, last-prompt, file-history-*, attachment...) is internal CLI state
    // without thread translation.
    return events
  }
  return {
    snapshot,
    push(entry: TranscriptEntry) {
      const events = push(entry)
      count += events.length
      return events
    },
    finish(ts: number): TranslatedEvent[] {
      if (!inTurn) return []
      inTurn = false
      return [{ ts, event: { type: 'session.ended', reason: 'interrupted' } }]
    },
  }
}

function translateThread(entries: TranscriptEntry[], cwd: string, thread: string | null) {
  const translator = transcriptTranslator(cwd, thread)
  const events = entries.flatMap((entry) => translator.push(entry))
  events.push(...translator.finish(events.at(-1)?.ts ?? Date.now()))
  return { events, model: translator.snapshot().model }
}
