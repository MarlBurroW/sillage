import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { SillageEvent } from '@sillage/protocol'
import {
  applyEvent, emptyChatState, workflowAgentThread,
  type ChatState, type WorkflowAgentThreadPage,
} from '@sillage/protocol/chat-state'
import { transcriptPath, transcriptTranslator, type TranscriptEntry, type TranscriptTranslationState } from './transcript.js'
import { TranscriptChanged, TranscriptReader } from './transcript-reader.js'

/**
 * Workflow agents' threads, read back from the transcripts Claude Code writes for them under
 * `<session>/subagents/workflows/wf_<id>/agent-<agentId>.jsonl`. The SDK stream carries none of their
 * messages (probed on 2.1.318: progress snapshots only), so these files are the only source. The
 * CLI appends to them as the agent works, which lets a running agent be followed by polling.
 *
 * Each file is folded once and then only its new bytes: a busy workflow writes tens of megabytes,
 * and the panel asks again every few seconds while an agent runs.
 */

/** Files kept folded: one per agent someone is looking at, a few more for going back and forth. */
const CACHE_SIZE = 8
/** Tool outputs past this many characters are cut: the panel shows a thread, not a file dump. */
const OUTPUT_CHARS = 16_000
/** CLI agent ids are short hex strings; anything else would only serve to escape the directory. */
const AGENT_ID = /^[a-zA-Z0-9_-]{1,64}$/

interface Folded {
  path: string
  /** Same inode and a size that only grew: the file was appended to, not replaced. */
  dev: string
  ino: string
  offset: number
  translation: TranscriptTranslationState
  state: ChatState
  seq: number
}

const cache = new Map<string, Folded>()
const pending = new Map<string, Promise<Folded | null>>()

export async function readWorkflowAgentThread(cwd: string, sessionId: string, agentId: string, limit: number, known: number | null = null): Promise<WorkflowAgentThreadPage> {
  if (!AGENT_ID.test(agentId)) return { unchanged: false, items: null, earlier: 0, version: 0 }
  const key = `${cwd}\0${sessionId}\0${agentId}`
  // One fold at a time per file: two panels polling the same agent share it.
  let run = pending.get(key)
  if (!run) {
    run = fold(key, cwd, sessionId, agentId).finally(() => pending.delete(key))
    pending.set(key, run)
  }
  const folded = await run
  if (!folded) return { unchanged: false, items: null, earlier: 0, version: 0 }
  // The version alone answers a reader polling a thread that has not moved.
  if (known === folded.seq) return { unchanged: true, version: folded.seq }
  const items = folded.state.items
  const start = Math.max(items.length - limit, 0)
  return { unchanged: false, items: items.slice(start), earlier: start, version: folded.seq }
}

async function fold(key: string, cwd: string, sessionId: string, agentId: string): Promise<Folded | null> {
  const previous = cache.get(key)
  const path = previous?.path ?? await locate(cwd, sessionId, agentId)
  if (!path) return null
  const reader = await TranscriptReader.open(path)
  if (!reader) {
    cache.delete(key)
    return null
  }
  try {
    const appended = previous && previous.dev === reader.stamp.dev && previous.ino === reader.stamp.ino && previous.offset <= reader.stamp.size
    const thread = workflowAgentThread(agentId)
    const base: Folded = appended ? previous : {
      path, dev: reader.stamp.dev, ino: reader.stamp.ino, offset: 0,
      translation: transcriptTranslator(cwd, thread).snapshot(), state: emptyChatState(), seq: 0,
    }
    if (appended && previous.offset === reader.stamp.size) return touch(key, previous)

    const translator = transcriptTranslator(cwd, thread, base.translation)
    let { state, seq, offset } = base
    try {
      for await (const line of reader.lines(base.offset, createHash('sha256'))) {
        offset = line.end
        if (!line.entry) continue
        for (const { ts, event } of translator.push(readable(line.entry))) state = applyEvent(state, ++seq, ts, trimmed(event))
      }
    } catch (error) {
      // The agent wrote more while we read: everything up to the size seen at opening is folded,
      // and the rest comes with the next request.
      if (!(error instanceof TranscriptChanged)) throw error
    }
    return touch(key, { ...base, offset, translation: translator.snapshot(), state, seq })
  } finally {
    await reader.file.close()
  }
}

function touch(key: string, folded: Folded): Folded {
  cache.delete(key)
  cache.set(key, folded)
  // Map order is insertion order: the first key is the one used least recently.
  while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!)
  return folded
}

/** Workflow directories are named by the CLI (`wf_<id>`) and not announced: look for the agent's file in each. */
async function locate(cwd: string, sessionId: string, agentId: string): Promise<string | null> {
  const root = join(transcriptPath(cwd, sessionId).replace(/\.jsonl$/, ''), 'subagents', 'workflows')
  let dirs: string[]
  try { dirs = await readdir(root) } catch { return null }
  const file = `agent-${agentId}.jsonl`
  for (const dir of dirs) {
    try {
      if ((await readdir(join(root, dir))).includes(file)) return join(root, dir, file)
    } catch { /* not a directory, or gone meanwhile */ }
  }
  return null
}

/**
 * The CLI wraps a workflow agent's task in a harness preamble, then indents the script's text by
 * two spaces so no line can pose as a frame. The agent's prompt is that text, not the wrapping.
 */
const HARNESS_PREFIX = '[Workflow harness'
const HARNESS_MARKER = 'The computed task text follows:\n'

function readable(entry: TranscriptEntry): TranscriptEntry {
  const content = entry.message?.content
  if (entry.type !== 'user' || typeof content !== 'string' || !content.startsWith(HARNESS_PREFIX)) return entry
  const at = content.indexOf(HARNESS_MARKER)
  if (at === -1) return entry
  const task = content.slice(at + HARNESS_MARKER.length).replace(/^ {2}/gm, '')
  return { ...entry, message: { ...entry.message, content: task } }
}

function trimmed(event: SillageEvent): SillageEvent {
  if (event.type !== 'tool.completed') return event
  return { ...event, output: trimOutput(event.output) }
}

function trimOutput(output: unknown): unknown {
  if (typeof output === 'string') return cut(output)
  if (!Array.isArray(output)) return output
  return output.map((block: unknown) => {
    if (!block || typeof block !== 'object') return block
    const typed = block as { type?: unknown; text?: unknown }
    if (typed.type === 'text' && typeof typed.text === 'string') return { ...typed, text: cut(typed.text) }
    // Base64 images would weigh more than the rest of the thread together.
    if (typed.type === 'image') return { type: 'text', text: '[image]' }
    return block
  })
}

function cut(text: string): string {
  return text.length > OUTPUT_CHARS ? `${text.slice(0, OUTPUT_CHARS)}\n…` : text
}
