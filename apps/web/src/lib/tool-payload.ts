/**
 * Read tool payloads. They cross the log without schemas (I3 normalizes envelopes only), so
 * renderers cannot assume field presence or types. Accessors return null rather than throw,
 * allowing raw-view fallback instead of breaking the whole thread.
 */

export function fields(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function text(value: unknown, key: string): string | null {
  const found = fields(value)?.[key]
  return typeof found === 'string' && found.length > 0 ? found : null
}

/** Display form of a primitive regardless of original type. */
export function scalar(value: unknown, key: string): string | null {
  const found = fields(value)?.[key]
  if (typeof found === 'number' || typeof found === 'boolean') return String(found)
  return typeof found === 'string' && found.length > 0 ? found : null
}

export function flag(value: unknown, key: string): boolean {
  return fields(value)?.[key] === true
}

export function list(value: unknown, key: string): unknown[] | null {
  const found = fields(value)?.[key]
  return Array.isArray(found) ? found : null
}

/**
 * Tool output as text. Claude Code supplies tool_result content as a string or blocks, retaining
 * only text blocks because screenshots do not belong in pre tags. Codex supplies aggregate command
 * output directly. Other forms return null to request a specialized or raw view.
 */
export function outputText(output: unknown, maxChars = Infinity): string | null {
  if (typeof output === 'string') return output.slice(0, maxChars)

  const content = Array.isArray(output) ? output : fields(output)?.content
  if (Array.isArray(content)) {
    const parts: string[] = []
    let remaining = maxChars
    for (const block of content) {
      if (remaining <= 0) break
      const value = text(block, 'text')
      if (value === null) continue
      const part = value.slice(0, remaining)
      parts.push(part)
      remaining -= part.length + 1
    }
    return parts.length > 0 ? parts.join('\n') : null
  }

  return null
}

export interface ImageBlock {
  mediaType: string
  data: string
}

/** Images from Claude and MCP outputs; neighboring text renders separately. */
export function imageBlocks(output: unknown): ImageBlock[] {
  const content = Array.isArray(output) ? output : fields(output)?.content
  if (!Array.isArray(content)) return []
  return content.flatMap((block) => {
    const f = fields(block)
    if (f?.type !== 'image') return []
    const source = fields(f.source)
    const mediaType = source?.media_type ?? f.mimeType
    const data = source?.data ?? f.data
    return typeof mediaType === 'string' && /^image\//.test(mediaType) && typeof data === 'string' && data.length > 0
      ? [{ mediaType, data }] : []
  })
}

export function imageBlock(output: unknown): ImageBlock | null {
  return imageBlocks(output)[0] ?? null
}

/** Nonempty output lines for tools returning one result per line. */
export function outputLines(output: unknown): string[] | null {
  const raw = outputText(output)
  if (raw === null) return null
  const lines = raw.split('\n').filter((line) => line.trim().length > 0)
  return lines.length > 0 ? lines : null
}

/** The cat -n gutter preceding every line, such as numbered tab-separated content. */
const GUTTER = /^\s*\d+\t/

/**
 * Strip Claude Code's read-output numbering, returning null when absent. Every line must match:
 * partial numeric prefixes indicate content discussing numbers. Numbering is CLI presentation
 * rather than file content and prevents useful highlighting/copying. Raw views retain it.
 */
export function stripLineNumbers(content: string): string | null {
  const lines = content.split('\n')
  const numbered = lines.filter((line) => line.length > 0)
  if (numbered.length === 0 || !numbered.every((line) => GUTTER.test(line))) return null
  return lines.map((line) => line.replace(GUTTER, '')).join('\n')
}
