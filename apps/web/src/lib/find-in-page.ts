/**
 * Search the displayed thread. Operate on DOM rather than fold items to include rendered Markdown
 * and tool content and directly obtain ranges for the highlighting API.
 */

/** Container text segment with its position in reconstructed text. */
interface Segment {
  node: Text
  /** Start index of this node in the folded string. */
  start: number
  /** Original index of each folded character for mapping back to node offsets. */
  offsets: number[]
}

/**
 * Fold text for comparison: lowercase without accents. Process character by character rather than
 * normalizing the whole string: accented characters decompose into multiple characters and would
 * shift subsequent highlight positions.
 */
function foldChar(character: string): string {
  return character
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
}

export function fold(text: string): string {
  let folded = ''
  for (const character of text) folded += foldChar(character)
  return folded
}

/** Reconstruct visible container text while retaining node references. */
function scan(container: HTMLElement): { text: string; segments: Segment[] } {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  const segments: Segment[] = []
  let text = ''

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue
    if (!value || !(node instanceof Text)) continue

    const offsets: number[] = []
    let folded = ''
    let at = 0

    for (const character of value) {
      const replaced = foldChar(character)
      for (let i = 0; i < replaced.length; i += 1) offsets.push(at)
      folded += replaced
      at += character.length
    }

    if (!folded) continue
    segments.push({ node, start: text.length, offsets })
    text += folded
  }

  return { text, segments }
}

/** Node and offset corresponding to a position in the folded string. */
function locate(segments: Segment[], position: number): { node: Text; offset: number } | null {
  // Binary search: long threads contain thousands of nodes, so scanning for each match boundary
  // would cause typing lag.
  let low = 0
  let high = segments.length - 1

  while (low <= high) {
    const middle = (low + high) >> 1
    const segment = segments[middle]
    if (!segment) break

    if (position < segment.start) high = middle - 1
    else if (position >= segment.start + segment.offsets.length) low = middle + 1
    else {
      return {
        node: segment.node,
        offset: segment.offsets[position - segment.start] ?? 0,
      }
    }
  }

  // Position at a segment's end: an end boundary equals node length rather than an index inside it.
  const last = segments.at(-1)
  return last ? { node: last.node, offset: last.node.nodeValue?.length ?? 0 } : null
}

/**
 * All `query` occurrences as DOM ranges. Reconstructed contiguous text finds matches across nodes
 * too, including words split by `<strong>`.
 */
export function findRanges(container: HTMLElement, query: string): Range[] {
  const needle = fold(query.trim())
  if (!needle) return []

  const { text, segments } = scan(container)
  const ranges: Range[] = []

  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) {
    const from = locate(segments, at)
    const to = locate(segments, at + needle.length)
    if (!from || !to) continue

    const range = document.createRange()
    range.setStart(from.node, from.offset)
    range.setEnd(to.node, to.offset)
    ranges.push(range)
  }

  return ranges
}

/** Whether the browser can highlight ranges without modifying the document. */
export function supportsHighlight(): boolean {
  return typeof CSS !== 'undefined' && 'highlights' in CSS
}
