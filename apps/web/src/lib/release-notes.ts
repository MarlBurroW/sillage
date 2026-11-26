/** Settings route of the release notes page, which loads on demand. */
export const RELEASE_NOTES_PATH = '/settings/notes-de-version'

/**
 * The opening sentence of a release's notes, as plain text, for a folded row. Recent notes open
 * with a one-line summary; older ones start on a heading or a list, which say nothing on their
 * own: those rows get no summary rather than a fragment.
 */
export function releaseSummary(body: string): string | null {
  const blocks = body.replace(/\r\n/g, '\n').split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean)
  // A leading warning quote (v0.36.0) can precede the summary: look a little further.
  for (const block of blocks.slice(0, 3)) {
    if (/^>/.test(block)) continue
    if (/^(#|[-*+] |\d+\. |\||```)/.test(block)) return null
    return plainText(block)
  }
  return null
}

function plainText(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
