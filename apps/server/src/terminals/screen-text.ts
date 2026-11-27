/**
 * Plain text from a terminal byte stream, for readers that are not terminals (agents reading an
 * action's output). Escape sequences are dropped rather than interpreted: colors and titles carry
 * nothing a reader needs, and a full emulator would be heavy for that. Carriage returns are the
 * exception, since progress bars and spinners redraw one line with them: keeping only what the
 * last redraw wrote turns hundreds of frames into the line a person last saw.
 */

/** OSC (titles, hyperlinks) ends with BEL or ST; DCS, SOS, PM and APC end with ST. */
const STRING_SEQUENCE = /\x1b[\]PX^_][\s\S]*?(?:\x07|\x1b\\)/g
/** CSI: colors, cursor moves, erasures. */
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g
/** Charset designation (`ESC ( B`) and the remaining two-byte escapes (`ESC =`, `ESC 7`). */
const SHORT_ESCAPE = /\x1b(?:[()*+][0-9A-Za-z]|[ -/]*[0-~])/g
/** Controls a reader has no use for; tab and newline stay. */
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

export function screenText(raw: string): string {
  const stripped = raw.replace(STRING_SEQUENCE, '').replace(CSI, '').replace(SHORT_ESCAPE, '')
  return stripped
    .replace(/\r+\n/g, '\n')
    .split('\n')
    .map((line) => {
      // What the last redraw wrote; a trailing return before the next line leaves it intact.
      const frames = line.split('\r').filter((frame) => frame.length > 0)
      return eraseBackspaces(frames.at(-1) ?? '').replace(CONTROL, '').trimEnd()
    })
    .join('\n')
}

function eraseBackspaces(line: string): string {
  if (!line.includes('\b')) return line
  const out: string[] = []
  for (const char of line) {
    if (char === '\b') out.pop()
    else out.push(char)
  }
  return out.join('')
}

/**
 * Last `lines` lines of a text, without the blank lines a cleared screen leaves at its end. Also
 * reports how many earlier lines were left out, so a reader knows the start is elsewhere.
 */
export function tailLines(text: string, lines: number, maxChars: number): { text: string; omitted: number } {
  const all = text.replace(/\n+$/, '').split('\n')
  let kept = all.slice(-lines)
  // A single huge line (minified output, a JSON dump) must not blow the reader's budget.
  while (kept.length > 1 && kept.join('\n').length > maxChars) kept = kept.slice(1)
  let body = kept.join('\n')
  if (body.length > maxChars) body = `…${body.slice(-maxChars)}`
  return { text: body, omitted: all.length - kept.length }
}
