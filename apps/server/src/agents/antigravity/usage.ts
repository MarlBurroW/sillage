/** A turn's tokens in the journal's vocabulary: `inputTokens` excludes the cache read. */
export interface AntigravityTurnTokens {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0)

/**
 * Reads the ACP `usage` of a `session/prompt` result. Its meaning changed between releases:
 * 1.4.x sends Google's raw `prompt_token_count` as `inputTokens`, cache read included, and keeps
 * `thoughtTokens` out of `outputTokens`; 1.5.x sends input net of the cache and output that
 * already includes the reasoning. `totalTokens` tells the two apart without trusting a version
 * number: it is `input + output + thought` in the first form, `input + cacheRead + output` in
 * the second. When both or neither add up, a cache read larger than the input can only be net,
 * and reasoning larger than the output can only be gross; otherwise the net form of the
 * targeted release (1.5.2) is assumed.
 */
export function antigravityTurnTokens(usage: Record<string, unknown>): AntigravityTurnTokens {
  const input = count(usage.inputTokens)
  const output = count(usage.outputTokens)
  const thought = count(usage.thoughtTokens)
  const read = count(usage.cachedReadTokens)
  const written = count(usage.cachedWriteTokens)
  const total = typeof usage.totalTokens === 'number' ? usage.totalTokens : null
  const gross = total !== null && input + output + thought === total
  const net = total !== null && input + read + output === total
  const isNet = net !== gross ? net : read > input || thought <= output
  return isNet
    ? { inputTokens: input, outputTokens: output, cacheReadTokens: read, cacheCreationTokens: written }
    : { inputTokens: Math.max(0, input - read), outputTokens: output + thought, cacheReadTokens: read, cacheCreationTokens: written }
}
