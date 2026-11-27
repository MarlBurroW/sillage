import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { AntigravityTurnTokens } from './usage.js'

/**
 * Antigravity's `PromptResponse.usage` covers the main trajectory only: Google reads
 * `trajectory_usages[<sessionId>]` and leaves sub-agents out. Each sub-agent keeps its own
 * transcript beside the session's, `brain/<id>/.system_generated/logs/transcript_full.jsonl`,
 * whose `PLANNER_RESPONSE` steps carry `input_tokens` net of the cache, `cache_read_tokens` and
 * `output_tokens` reasoning included. Probed on 1.4.3 and 1.5.2: summed over the main transcript,
 * they match the turns' ACP usage once read by `antigravityTurnTokens`. The parent's
 * `INVOKE_SUBAGENT` step names the children it created; they may create their own.
 */

export interface TranscriptStep { index: number | null; createdAt: number; tokens: AntigravityTurnTokens | null; children: string[] }

const CHILD = /"conversationId":\s*"([\w-]+)"/g
const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)

export function transcriptPath(brain: string, id: string): string {
  return join(brain, id, '.system_generated', 'logs', 'transcript_full.jsonl')
}

export function parseTranscriptLine(line: string): TranscriptStep | null {
  let step: Record<string, unknown>
  try { step = JSON.parse(line) } catch { return null }
  if (!step || typeof step !== 'object') return null
  const index = typeof step.step_index === 'number' ? step.step_index : null
  const createdAt = Date.parse(String(step.created_at ?? ''))
  const tokens = step.type === 'PLANNER_RESPONSE'
    ? { inputTokens: count(step.input_tokens), outputTokens: count(step.output_tokens), cacheReadTokens: count(step.cache_read_tokens), cacheCreationTokens: 0 }
    : null
  const children = step.type === 'INVOKE_SUBAGENT' && typeof step.content === 'string' ? [...step.content.matchAll(CHILD)].map((match) => match[1]!) : []
  return { index, createdAt: Number.isFinite(createdAt) ? createdAt : 0, tokens, children }
}

export const noTokens = (): AntigravityTurnTokens => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 })
export function addTokens(into: AntigravityTurnTokens, tokens: AntigravityTurnTokens): void {
  into.inputTokens += tokens.inputTokens
  into.outputTokens += tokens.outputTokens
  into.cacheReadTokens += tokens.cacheReadTokens
  into.cacheCreationTokens += tokens.cacheCreationTokens
}
export const hasTokens = (tokens: AntigravityTurnTokens): boolean => tokens.inputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheCreationTokens > 0

interface Cursor { offset: number; seen: Set<number> }

/**
 * What a session's sub-agents consumed since the previous call, read incrementally: each
 * transcript is read from where the last call stopped, up to its last complete line. Steps are
 * also remembered by index, as their order on disk is not theirs (seen unsorted in production),
 * so a transcript rewritten from the start is not counted twice.
 */
export class AntigravitySubAgentUsage {
  private readonly cursors = new Map<string, Cursor>()
  private readonly children = new Set<string>()

  constructor(private readonly brain: string) {}

  /** Takes everything already on disk as counted: a resumed session's past was counted before. */
  baseline(sessionId: string): void { this.collect(sessionId) }

  /** Tokens per sub-agent since the last call, sub-agents without new consumption left out. */
  settle(sessionId: string): { id: string; tokens: AntigravityTurnTokens }[] {
    return this.collect(sessionId)
  }

  private collect(sessionId: string): { id: string; tokens: AntigravityTurnTokens }[] {
    for (const step of this.read(sessionId)) for (const child of step.children) if (child !== sessionId) this.children.add(child)
    const used: { id: string; tokens: AntigravityTurnTokens }[] = []
    // A Set visits what is added while it is iterated: grandchildren are read in the same pass.
    for (const id of this.children) {
      const tokens = noTokens()
      for (const step of this.read(id)) {
        if (step.tokens) addTokens(tokens, step.tokens)
        for (const child of step.children) if (child !== sessionId) this.children.add(child)
      }
      if (hasTokens(tokens)) used.push({ id, tokens })
    }
    return used
  }

  private read(id: string): TranscriptStep[] {
    const path = transcriptPath(this.brain, id)
    let size: number
    try { size = statSync(path).size } catch { return [] }
    const cursor = this.cursors.get(id) ?? { offset: 0, seen: new Set<number>() }
    this.cursors.set(id, cursor)
    if (size < cursor.offset) cursor.offset = 0
    if (size === cursor.offset) return []
    const buffer = Buffer.alloc(size - cursor.offset)
    const fd = openSync(path, 'r')
    try { readSync(fd, buffer, 0, buffer.length, cursor.offset) } finally { closeSync(fd) }
    // A step still being written stays for the next call.
    const end = buffer.lastIndexOf(0x0a) + 1
    if (end === 0) return []
    cursor.offset += end
    const steps: TranscriptStep[] = []
    for (const line of buffer.subarray(0, end).toString('utf8').split('\n')) {
      const step = line.trim() ? parseTranscriptLine(line) : null
      if (!step) continue
      if (step.index !== null) {
        if (cursor.seen.has(step.index)) continue
        cursor.seen.add(step.index)
      }
      steps.push(step)
    }
    return steps
  }
}
