import type { MessageInfo } from '@sillage/opencode-bindings/v2'
import type { SillageEvent } from '@sillage/protocol'
import { opencodeErrorCode } from '../errors.js'
import { contentText, describeTool, fileEdits, QUESTION_TOOL, type CompletedCall } from './tools.js'

/**
 * A stored OpenCode 2 session as journal events, for adopting a session begun outside Sillage.
 *
 * Translates what `GET /api/session/{id}/message` keeps (probed 2.4.1), not the live stream:
 * user prompts, assistant messages with their final text, reasoning and tool calls, `idle`
 * markers closing each execution, compactions and user shell commands. Turns open on a prompt or
 * on a wake-up (a synthetic inbox item) and close on `idle`. Subagent sessions are not replayed:
 * their call keeps its result. Model and agent switches have no journal counterpart.
 */

export interface HistoryEntry {
  event: SillageEvent
  raw?: unknown
}

type Usage = { cost: number; input: number; output: number; cacheRead: number; cacheWrite: number }

export function historyEvents(sessionId: string, messages: MessageInfo[], cwd: string, mcpServers: string[]): HistoryEntry[] {
  const out: HistoryEntry[] = []
  let open = false
  let usage: Usage = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  let lastAssistant: string | null = null

  const begin = () => {
    if (open) return
    open = true
    out.push({ event: { type: 'turn.started' } })
  }
  const end = (stopReason: string) => {
    if (!open) return
    open = false
    out.push({
      event: { type: 'turn.completed', stopReason, costUsd: usage.cost, inputTokens: usage.input, outputTokens: usage.output, cacheReadTokens: usage.cacheRead, cacheCreationTokens: usage.cacheWrite },
      // Forks cut after the turn's last assistant message, like live turns.
      raw: { sessionID: sessionId, messageID: lastAssistant },
    })
    usage = { cost: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  }

  for (const message of messages) {
    switch (message.type) {
      case 'user':
        begin()
        out.push({ event: { type: 'message.completed', messageId: message.id, role: 'user', blocks: [{ type: 'text', text: message.text }], parentToolCallId: null }, raw: message })
        break
      case 'synthetic':
        // A background result waking the session: the execution it starts is a turn of its own.
        begin()
        break
      case 'assistant': {
        begin()
        lastAssistant = message.id
        if (message.tokens) {
          usage.cost += message.cost ?? 0
          usage.input += message.tokens.input
          usage.output += message.tokens.output + message.tokens.reasoning
          usage.cacheRead += message.tokens.cache.read
          usage.cacheWrite += message.tokens.cache.write
        }
        message.content.forEach((block, index) => {
          if (block.type === 'text' || block.type === 'reasoning') {
            if (!block.text.trim()) return
            const kind = block.type === 'text' ? 'text' : 'thinking'
            out.push({ event: { type: 'message.completed', messageId: `${message.id}:${block.type}:${index}`, role: 'assistant', blocks: [{ type: kind, text: block.text }], parentToolCallId: null }, raw: { data: { assistantMessageID: message.id } } })
            return
          }
          if (block.name === QUESTION_TOOL) return
          const described = describeTool(block.name, block.state.input, mcpServers)
          out.push({ event: { type: 'tool.started', toolCallId: block.id, ...described, presentation: {}, parentToolCallId: null } })
          if (block.state.status !== 'completed' && block.state.status !== 'error') {
            out.push({ event: { type: 'tool.completed', toolCallId: block.id, output: 'Tool execution aborted', isError: true, durationMs: 0 } })
            return
          }
          const isError = block.state.status === 'error'
          const text = contentText('content' in block.state ? block.state.content : undefined)
          const output = block.state.status === 'error' ? (text || block.state.error.message) : text
          const metadata = block.state.status === 'completed' ? block.state.metadata : undefined
          const call: CompletedCall = { tool: block.name, input: block.state.input, metadata, output }
          const durationMs = block.time.completed ? Math.max(0, block.time.completed - (block.time.ran ?? block.time.created)) : 0
          out.push({ event: { type: 'tool.completed', toolCallId: block.id, output, isError, durationMs }, raw: { call } })
          if (!isError) for (const edit of fileEdits(block.id, call, cwd)) out.push({ event: edit })
        })
        if (message.error && message.error.type !== 'aborted') {
          out.push({ event: { type: 'error', code: opencodeErrorCode(message.error.type), message: message.error.message || message.error.type, recoverable: true }, raw: message })
        }
        break
      }
      case 'shell': {
        // A command the user ran directly (`!cmd` in OpenCode's interfaces).
        begin()
        out.push({ event: { type: 'tool.started', toolCallId: message.id, name: 'Bash', input: { command: message.command }, presentation: {}, parentToolCallId: null } })
        const durationMs = message.time.completed ? Math.max(0, message.time.completed - message.time.created) : 0
        out.push({ event: { type: 'tool.completed', toolCallId: message.id, output: message.output?.output ?? '', isError: message.status !== 'exited' || (typeof message.exit === 'number' && message.exit !== 0), durationMs } })
        break
      }
      case 'compaction':
        if (message.status === 'completed') out.push({ event: { type: 'context.compacted', trigger: message.reason, preTokens: null, postTokens: null } })
        break
      case 'idle':
        if (message.outcome === 'failed' && message.error) {
          out.push({ event: { type: 'error', code: opencodeErrorCode(message.error.type), message: message.error.message || message.error.type, recoverable: true } })
        }
        end(message.outcome === 'succeeded' ? 'completed' : message.outcome === 'interrupted' ? 'interrupted' : 'failed')
        break
      default:
        // Model, agent and location switches, system notes, skill activations: no journal event.
        break
    }
  }
  end('completed')
  return out
}
