/**
 * Fuzzy matching like command palettes: “cmdpal” finds “CommandPalette.tsx”; “offline cach”
 * finds “Add offline caching”.
 *
 * Shared by the palette ranking in-memory items and the server preselecting project files:
 * different rankings could make the server discard a file the palette would place first.
 */

export interface FuzzyMatch {
  /** Higher is better. Comparable only with scores for the same query. */
  score: number
  /** Matched positions in the original text, ascending, for highlighting. */
  positions: number[]
}

/**
 * Beyond this, optimal alignment costs more than it is worth: long text uses the first
 * available alignment, affecting only tie ordering.
 */
const ALIGN_MAX_TEXT = 256
const MAX_TOKEN = 64
const MAX_TOKENS = 8

/** Points per matched letter, then bonuses for word starts and consecutive letters. */
const BASE = 1
const WORD_START = 2
const CONSECUTIVE = 3
const TEXT_START = 1

/**
 * Cost of a gap between matched letters, increasing with distance. Jumps to word starts are
 * cheap, matching initials; jumps farther within a word cost more. Landing inside another word
 * is forbidden: “power” must not match “Ap*p*r*o*valsRevie*wer*” by picking letters from each
 * word.
 */
const GAP_OPEN = 0.5
const GAP_PER_CHAR = 0.2
const GAP_PER_CHAR_TO_WORD = 0.05

/**
 * Required average per query letter, higher for longer text. Below it, matches are too
 * scattered to mean anything; a single letter must at least start a word. Long camelCase names
 * offer enough word starts to assemble almost anything, hence the growing requirement.
 */
function minimumPerLetter(length: number): number {
  return 1.2 + Math.min(length, 60) * 0.015
}

const SEPARATORS = new Set(' \t\n-_./\\:,;()[]{}#@\'"`·›|+&')

/**
 * Case and accents removed one character at a time: positions in folded text must identify the
 * same letters in displayed text.
 */
export function foldForMatch(text: string): string {
  // The common unaccented case folds in one step without changing length.
  if (/^[\x00-\x7f]*$/.test(text)) return text.toLowerCase()
  let folded = ''
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string
    folded += char.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()[0] ?? char
  }
  return folded
}

/**
 * Query words searched independently: word order does not matter. Slashes also separate, as in
 * VS Code: “web/pal” searches for `web` in the directory and `pal` in the filename.
 */
export function fuzzyTokens(query: string): string[] {
  return query
    .trim()
    .split(/[\s/]+/)
    .filter(Boolean)
    .slice(0, MAX_TOKENS)
    .map((token) => foldForMatch(token.slice(0, MAX_TOKEN)))
}

/**
 * Word start: after a separator or at a camelCase boundary. This is where initials aim.
 */
function isWordStart(text: string, index: number): boolean {
  if (index === 0) return true
  const previous = text[index - 1] as string
  if (SEPARATORS.has(previous)) return true
  const current = text[index] as string
  return previous !== previous.toUpperCase() && current !== current.toLowerCase()
}

function letterScore(text: string, index: number): number {
  return BASE + (isWordStart(text, index) ? WORD_START : 0) + (index === 0 ? TEXT_START : 0)
}

/** Does a word start separate these positions? */
function crossesWord(text: string, from: number, to: number): boolean {
  for (let index = from + 1; index <= to; index += 1) {
    if (isWordStart(text, index)) return true
  }
  return false
}

function gapCost(text: string, from: number, to: number): number {
  const skipped = to - from - 1
  return GAP_OPEN + skipped * (isWordStart(text, to) ? GAP_PER_CHAR_TO_WORD : GAP_PER_CHAR)
}

/**
 * Tie-breaking equal-quality matches: earliest, then shortest. Capped so it never outweighs a
 * better-placed letter.
 */
function tieBreak(first: number, length: number): number {
  return -Math.min(first, 30) * 0.02 - Math.min(length, 200) * 0.002
}

function accept(score: number, positions: number[], length: number): FuzzyMatch | null {
  if (score < positions.length * minimumPerLetter(length)) return null
  return { score: score + tieBreak(positions[0] ?? 0, length), positions }
}

/**
 * Do `token` letters appear in order? Pre-calculation filter also used by the server to discard
 * thousands of irrelevant paths at once.
 */
export function containsInOrder(folded: string, token: string): boolean {
  let at = 0
  for (const char of token) {
    at = folded.indexOf(char, at)
    if (at === -1) return false
    at += 1
  }
  return true
}

/**
 * Alignment tables reused across calls: a keystroke aligns hundreds of items; allocating each
 * time would needlessly feed the garbage collector.
 */
let bestTable = new Float64Array(0)
let fromTable = new Int32Array(0)

function tables(size: number): { best: Float64Array; from: Int32Array } {
  if (bestTable.length < size) {
    bestTable = new Float64Array(size)
    fromTable = new Int32Array(size)
  }
  bestTable.fill(-Infinity, 0, size)
  fromTable.fill(-1, 0, size)
  return { best: bestTable, from: fromTable }
}

/**
 * How to search for a word in a field.
 *
 * - `fuzzy`: letters in order, anywhere. For short identifiers, filenames or skill names where
 * “cmdpal” must find “CommandPalette”.
 * - `words`: a contiguous segment anywhere, then jumps only to word starts. For sentences,
 * where scattered letters always match but mean nothing, while “aocf” should find “Add offline
 * caching for”.
 * - `strict`: one contiguous segment. For descriptions or project names shown as context.
 */
export type FuzzyMode = 'fuzzy' | 'words' | 'strict'

/**
 * Best alignment by dynamic programming: a greedy letter-by-letter alignment takes the first
 * “p” in “apps/web/CommandPalette” and misses the “Palette” boundary. `best[j][i]` is the best
 * score for the first `j + 1` letters when the last lands at `i`.
 *
 * Since gap cost is affine in gap length, the best starting point is maintained along the row,
 * one per slope, keeping the whole algorithm linear per query letter.
 */
function align(text: string, folded: string, token: string, words: boolean): FuzzyMatch | null {
  const n = folded.length
  const m = token.length
  const { best, from } = tables(m * n)

  for (let i = 0; i < n; i += 1) {
    if (folded[i] === token[0]) best[i] = letterScore(text, i)
  }

  for (let j = 1; j < m; j += 1) {
    const previous = (j - 1) * n
    let towardWord = -Infinity
    let towardWordFrom = -1
    // Starting points for a jump inside a word must belong to that same word, hence
    // the reset at each word start.
    let midWord = -Infinity
    let midWordFrom = -1
    let wordStart = 0

    for (let i = 1; i < n; i += 1) {
      const word = isWordStart(text, i)
      if (word) {
        wordStart = i
        midWord = -Infinity
        midWordFrom = -1
      }
      // Possible jump starts towards `i`: all positions through `i - 2`.
      if (i >= 2) {
        const k = i - 2
        const candidate = best[previous + k] as number
        if (candidate + GAP_PER_CHAR_TO_WORD * k > towardWord) {
          towardWord = candidate + GAP_PER_CHAR_TO_WORD * k
          towardWordFrom = k
        }
        if (k >= wordStart && candidate + GAP_PER_CHAR * k > midWord) {
          midWord = candidate + GAP_PER_CHAR * k
          midWordFrom = k
        }
      }
      if (folded[i] !== token[j]) continue

      const jump = word
        ? towardWord - GAP_OPEN - GAP_PER_CHAR_TO_WORD * (i - 1)
        : words
          ? -Infinity
          : midWord - GAP_OPEN - GAP_PER_CHAR * (i - 1)
      const adjacent = (best[previous + i - 1] as number) + CONSECUTIVE
      const own = letterScore(text, i)

      if (adjacent >= jump && adjacent !== -Infinity) {
        best[j * n + i] = adjacent + own
        from[j * n + i] = i - 1
      } else if (jump !== -Infinity) {
        best[j * n + i] = jump + own
        from[j * n + i] = word ? towardWordFrom : midWordFrom
      }
    }
  }

  let end = -1
  let score = -Infinity
  for (let i = 0; i < n; i += 1) {
    const value = best[(m - 1) * n + i] as number
    if (value > score) {
      score = value
      end = i
    }
  }
  if (end === -1) return null

  const positions = new Array<number>(m)
  for (let j = m - 1, i = end; j >= 0; j -= 1) {
    positions[j] = i
    i = from[j * n + i] as number
  }
  return accept(score, positions, n)
}

/** First available alignment for text too long for optimal alignment. */
function greedy(text: string, folded: string, token: string, words: boolean): FuzzyMatch | null {
  const positions: number[] = []
  let score = 0
  let at = 0
  for (const char of token) {
    const last = positions.at(-1)
    let found = folded.indexOf(char, at)
    // Same permitted jumps as in alignment: to a word start, or farther within
    // the same word when the mode allows it.
    while (last !== undefined && found !== -1 && found !== last + 1 && !isWordStart(text, found) && (words || crossesWord(text, last, found))) {
      found = folded.indexOf(char, found + 1)
    }
    if (found === -1) return null
    if (last === undefined) score += letterScore(text, found)
    else if (last === found - 1) score += letterScore(text, found) + CONSECUTIVE
    else score += letterScore(text, found) - gapCost(text, last, found)
    positions.push(found)
    at = found + 1
  }
  return accept(score, positions, folded.length)
}

/**
 * Best-placed contiguous occurrence: word starts before interiors, then earliest.
 */
function contiguous(text: string, folded: string, token: string): FuzzyMatch | null {
  let start = -1
  for (let found = folded.indexOf(token); found !== -1; found = folded.indexOf(token, found + 1)) {
    if (start === -1) start = found
    if (isWordStart(text, found)) {
      start = found
      break
    }
  }
  if (start === -1) return null

  let score = 0
  for (let index = 0; index < token.length; index += 1) {
    score += letterScore(text, start + index) + (index > 0 ? CONSECUTIVE : 0)
  }
  const positions = Array.from({ length: token.length }, (_, index) => start + index)
  return accept(score, positions, folded.length)
}

/** One query word, already folded by `fuzzyTokens`, matched against text. */
export function fuzzyMatch(
  text: string,
  token: string,
  { mode = 'fuzzy', folded = foldForMatch(text) }: { mode?: FuzzyMode; folded?: string } = {},
): FuzzyMatch | null {
  if (!token) return { score: 0, positions: [] }
  if (mode === 'strict') return contiguous(text, folded, token)
  if (!containsInOrder(folded, token)) return null
  const words = mode === 'words'
  return folded.length > ALIGN_MAX_TEXT ? greedy(text, folded, token, words) : align(text, folded, token, words)
}

export interface FuzzyField {
  text: string
  /** Score contribution of this field: titles count more than descriptions. */
  weight: number
  mode?: FuzzyMode
  /** Folded text, when callers retain it across keystrokes. */
  folded?: string
}

export interface FieldsMatch {
  score: number
  /** Matched positions per field, in the supplied field order. */
  positions: number[][]
  /** Fields matching at least one query word. */
  matched: boolean[]
}

/**
 * Every word must match, each in its best-scoring field: “nimbus cache” finds a Nimbus
 * conversation whose title mentions caching.
 */
export function matchFields(fields: readonly FuzzyField[], tokens: readonly string[]): FieldsMatch | null {
  const positions = fields.map((): number[] => [])
  const matched = fields.map(() => false)
  let score = 0

  for (const token of tokens) {
    let bestScore = -Infinity
    let bestField = -1
    let bestPositions: number[] = []
    for (const [index, field] of fields.entries()) {
      const found = fuzzyMatch(field.text, token, { mode: field.mode, folded: field.folded })
      if (!found) continue
      const weighted = found.score * field.weight
      if (weighted > bestScore) {
        bestScore = weighted
        bestField = index
        bestPositions = found.positions
      }
    }
    if (bestField === -1) return null

    score += bestScore
    matched[bestField] = true
    positions[bestField]?.push(...bestPositions)
  }

  // Two words can match the same letters: “ca cach” in “caching”.
  const unique = positions.map((list) => [...new Set(list)].sort((a, b) => a - b))
  return { score, positions: unique, matched }
}
