/**
 * Spans of composer text that leave with the message as more than text: files picked from `@`
 * suggestions (sent as mentions), skills picked from `$` suggestions, and a leading `/command`
 * the CLI knows. Typed look-alikes are not resolved and stay plain, so a highlight means the
 * resource is attached.
 */

export type HighlightKind = 'mention' | 'skill' | 'command'

export interface HighlightRange {
  start: number
  end: number
  kind: HighlightKind
}

/** A token ends where its name cannot continue; a sentence's final period does not count as part of it. */
function endsAt(text: string, index: number): boolean {
  const next = text[index]
  if (next === undefined) return true
  if (/[\w/@$-]/.test(next)) return false
  return next !== '.' || !/[\w]/.test(text[index + 1] ?? '')
}

function occurrences(text: string, token: string, kind: HighlightKind): HighlightRange[] {
  const ranges: HighlightRange[] = []
  for (let start = text.indexOf(token); start >= 0; start = text.indexOf(token, start + 1)) {
    const before = text[start - 1]
    if (before !== undefined && !/\s|[([{"'`]/.test(before)) continue
    if (endsAt(text, start + token.length)) ranges.push({ start, end: start + token.length, kind })
  }
  return ranges
}

export function highlightRanges(
  text: string,
  { mentions, skills, commands }: { mentions: Iterable<string>; skills: Iterable<string>; commands: Iterable<string> },
): HighlightRange[] {
  const ranges = [
    ...[...mentions].flatMap((path) => occurrences(text, `@${path}`, 'mention')),
    ...[...skills].flatMap((name) => occurrences(text, `$${name}`, 'skill')),
  ]
  // Only a leading command runs; the same word later in the text is prose.
  const command = /^\/([\w:.-]+)/.exec(text)
  if (command && new Set(commands).has(command[1]!) && endsAt(text, command[0].length)) {
    ranges.push({ start: 0, end: command[0].length, kind: 'command' })
  }
  // Longest first so a path containing another keeps one span; then in text order.
  ranges.sort((a, b) => a.start - b.start || b.end - a.end)
  const kept: HighlightRange[] = []
  for (const range of ranges) if (!kept.length || range.start >= kept[kept.length - 1]!.end) kept.push(range)
  return kept
}
