import type { SillageEvent } from '@sillage/protocol'
import type { ThreadItem } from '@sillage/codex-bindings/v2'
import { toWorkspacePath } from '../paths.js'

type ToolStart = Extract<SillageEvent, { type: 'tool.started' }>

/** Exhaustivité à la compilation, repli lisible si le CLI est plus récent au runtime. */
function futureItem(item: never): ThreadItem {
  return item
}

function tool(item: ThreadItem): { name: string; input: unknown } | null {
  switch (item.type) {
    case 'commandExecution': return { name: 'Bash', input: { command: item.command, cwd: item.cwd } }
    case 'fileChange': return { name: 'Edit', input: { changes: item.changes } }
    case 'mcpToolCall': return { name: `${item.server}/${item.tool}`, input: item.arguments }
    case 'dynamicToolCall': return { name: [item.namespace, item.tool].filter(Boolean).join('/'), input: item.arguments }
    case 'collabAgentToolCall': return { name: `Collaboration/${item.tool}`, input: { prompt: item.prompt, agents: item.receiverThreadIds, model: item.model, reasoningEffort: item.reasoningEffort } }
    case 'webSearch': return {
      name: item.action?.type === 'openPage' ? 'WebFetch' : 'WebSearch',
      input: { query: item.query, ...item.action },
    }
    case 'imageView': return { name: 'ViewImage', input: { path: item.path } }
    case 'imageGeneration': return { name: 'ImageGeneration', input: { prompt: item.revisedPrompt } }
    case 'sleep': return { name: 'Sleep', input: { durationMs: item.durationMs } }
    case 'functionCallOutput': return { name: [item.namespace, item.name].filter(Boolean).join('/'), input: {} }
    case 'userMessage':
    case 'hookPrompt':
    case 'agentMessage':
    case 'plan':
    case 'reasoning':
    case 'subAgentActivity':
    case 'contextCompaction':
    case 'enteredReviewMode':
    case 'exitedReviewMode': return null
    default: {
      const unknown = futureItem(item)
      return { name: `Codex/${unknown.type}`, input: unknown }
    }
  }
}

export function startedItem(item: ThreadItem, parentToolCallId: string | null): SillageEvent[] {
  if (item.type === 'contextCompaction') return [{ type: 'context.compaction_started' }]
  const action = tool(item)
  return action ? [{ type: 'tool.started', toolCallId: item.id, ...action, parentToolCallId } satisfies ToolStart] : []
}

export function completedItem(
  item: ThreadItem, cwd: string, durationMs: number, parentToolCallId: string | null,
): SillageEvent[] {
  const finish = (output: unknown, isError = false, duration = durationMs): SillageEvent => ({
    type: 'tool.completed', toolCallId: item.id, output, isError, durationMs: duration,
  })
  switch (item.type) {
    case 'agentMessage':
    case 'plan': return [{
      type: 'message.completed', messageId: item.id, role: 'assistant', parentToolCallId,
      blocks: item.type === 'agentMessage' && item.questions?.length ? [] : [{ type: 'text', text: item.text }],
    }]
    case 'reasoning': {
      const text = [...item.summary, ...item.content].join('\n\n')
      return [{ type: 'message.completed', messageId: item.id, role: 'assistant', parentToolCallId,
        blocks: text ? [{ type: 'thinking', text }] : [] }]
    }
    case 'commandExecution': return [finish(item.aggregatedOutput, item.status === 'failed' || item.status === 'declined', item.durationMs ?? durationMs)]
    case 'fileChange': return [
      finish(item.changes, item.status === 'failed' || item.status === 'declined'),
      ...(item.status === 'completed' ? item.changes.map((change): SillageEvent => ({
        type: 'file.edited', toolCallId: item.id, path: toWorkspacePath(cwd, change.path),
        action: change.kind.type === 'add' ? 'created' : change.kind.type === 'delete' ? 'deleted' : 'modified',
      })) : []),
    ]
    case 'mcpToolCall': return [finish(item.result ?? item.error,
      item.status === 'failed' || item.error != null, item.durationMs ?? durationMs)]
    case 'dynamicToolCall': return [finish(item.contentItems, item.status === 'failed' || item.success === false, item.durationMs ?? durationMs)]
    case 'collabAgentToolCall': return [finish(item.agentsStates, item.status === 'failed')]
    case 'webSearch': return [finish({ query: item.query, action: item.action, results: item.results })]
    case 'imageView': return [finish({ path: item.path })]
    case 'imageGeneration': return [
      finish({ status: item.status, revisedPrompt: item.revisedPrompt, savedPath: item.savedPath, failure: item.failure }, item.failure != null || item.status === 'failed'),
      ...(item.result && !item.failure ? [{
        type: 'message.completed', messageId: `image-${item.id}`, role: 'assistant', parentToolCallId,
        blocks: [{ type: 'image', mimeType: 'image/png', url: `data:image/png;base64,${item.result}` }],
      } satisfies SillageEvent] : []),
    ]
    case 'sleep': return [finish({ durationMs: item.durationMs })]
    case 'functionCallOutput': return [finish(item.output)]
    case 'contextCompaction': return [{ type: 'context.compacted', trigger: 'unknown', preTokens: null, postTokens: null }]
    case 'hookPrompt': return [{ type: 'prompt.injected', text: item.fragments.map((fragment) => fragment.text).join('\n\n') }]
    case 'enteredReviewMode':
    case 'exitedReviewMode': return [{
      type: 'agent.notice', code: item.type, level: 'info',
      message: item.type === 'enteredReviewMode' ? 'Codex démarre une revue.' : 'Codex a terminé la revue.', details: item.review,
    }]
    case 'userMessage': // Déjà journalisé à l'envoi.
    case 'subAgentActivity': // Rattaché au sous-agent par le runner.
      return []
    default: return [finish(futureItem(item))]
  }
}
