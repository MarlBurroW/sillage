import { ADVISOR_TOOL, type AdvisorOutcome } from '@sillage/protocol'

/**
 * Advisor consultations, shared by the live runner and the transcript import.
 *
 * Shapes probed on Claude Code 2.1.332: the call is a `server_tool_use` named `advisor` with an
 * empty input, the answer an `advisor_tool_result` whose `content` is `advisor_result` (`text`),
 * `advisor_redacted_result` (`encrypted_content`) or `advisor_tool_result_error` (`error_code`);
 * a `stop_reason` of `refusal` on either result marks a declined consultation. The advisor's
 * tokens appear nowhere else in the message: only in `usage.iterations`, as entries of type
 * `advisor_message` carrying the model, one per consultation in call order.
 */

type Block = Record<string, unknown>

/** Tool call ID of an advisor call, or null for any other block. */
export function advisorCallId(block: Block): string | null {
  return block.type === 'server_tool_use' && block.name === ADVISOR_TOOL && typeof block.id === 'string' ? block.id : null
}

/** What an `advisor_tool_result` block says, before its usage is known; null for other blocks. */
export function advisorResult(block: Block): { toolCallId: string; outcome: AdvisorOutcome } | null {
  if (block.type !== 'advisor_tool_result' || typeof block.tool_use_id !== 'string') return null
  const content = (block.content && typeof block.content === 'object' ? block.content : {}) as Block
  const refused = content.stop_reason === 'refusal'
  const text = typeof content.text === 'string' && content.text.trim() ? content.text : null
  const outcome: AdvisorOutcome = content.type === 'advisor_tool_result_error'
    ? { status: 'unavailable', text: null, errorCode: typeof content.error_code === 'string' ? content.error_code : null, model: null, usage: null }
    : { status: refused ? 'refused' : content.type === 'advisor_redacted_result' ? 'redacted' : 'advised', text, errorCode: null, model: null, usage: null }
  return { toolCallId: block.tool_use_id, outcome }
}

/** Advisor runs listed in a message's `usage.iterations`, in call order. */
export function advisorIterations(usage: unknown): Pick<AdvisorOutcome, 'model' | 'usage'>[] {
  const iterations = (usage as { iterations?: unknown } | null | undefined)?.iterations
  if (!Array.isArray(iterations)) return []
  const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
  return iterations.flatMap((iteration: Block | null) => iteration?.type === 'advisor_message' ? [{
    model: typeof iteration.model === 'string' ? iteration.model : null,
    usage: {
      inputTokens: count(iteration.input_tokens),
      outputTokens: count(iteration.output_tokens),
      cacheReadTokens: count(iteration.cache_read_input_tokens),
      cacheCreationTokens: count(iteration.cache_creation_input_tokens),
    },
  }] : [])
}
