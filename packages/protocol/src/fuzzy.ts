/**
 * Correspondance floue, à la façon des palettes de commandes : « cmdpal » retrouve
 * « CommandPalette.tsx », « offline cach » retrouve « Add offline caching ».
 *
 * Partagée par la palette, qui classe ce qu'elle a en mémoire, et par le serveur, qui
 * présélectionne les fichiers des projets : deux classements différents feraient écarter
 * par le serveur un fichier que la palette aurait mis en tête.
 */

export interface FuzzyMatch {
  /** Plus haut vaut mieux. Ne se compare qu'à un autre score de la même saisie. */
  score: number
  /** Indices retenus dans le texte d'origine, croissants : de quoi surligner. */
  positions: number[]
}

/**
 * Au-delà, l'alignement optimal coûte plus qu'il ne rapporte : un texte long se contente
 * du premier alignement venu, ce qui ne change que l'ordre des ex aequo.
 */
const ALIGN_MAX_TEXT = 256
const MAX_TOKEN = 64
const MAX_TOKENS = 8

/** Points d'une lettre retenue, puis primes de début de mot et de lettres qui se suivent. */
const BASE = 1
const WORD_START = 2
const CONSECUTIVE = 3
const TEXT_START = 1

/**
 * Coût d'un saut entre deux lettres retenues, qui croît avec la distance. Sauter vers un
 * début de mot coûte peu, c'est taper des initiales ; sauter plus loin dans le même mot
 * coûte davantage. Atterrir au milieu d'un autre mot est exclu : « power » ne doit pas
 * retrouver « Ap*p*r*o*valsRevie*wer* » en piochant une lettre par mot.
 */
const GAP_OPEN = 0.5
const GAP_PER_CHAR = 0.2
const GAP_PER_CHAR_TO_WORD = 0.05

/**
 * Moyenne exigée par lettre de la saisie, plus haute dans un texte long. En deçà, les
 * lettres sont trouvées mais si dispersées que la correspondance ne dit plus rien ; une
 * lettre seule doit au moins ouvrir un mot. Un long nom en camelCase offre toujours
 * assez de débuts de mot pour composer n'importe quoi, d'où l'exigence qui croît.
 */
function minimumPerLetter(length: number): number {
  return 1.2 + Math.min(length, 60) * 0.015
}

const SEPARATORS = new Set(' \t\n-_./\\:,;()[]{}#@\'"`·›|+&')

/**
 * Casse et accents retirés, un caractère pour un caractère : les positions trouvées
 * dans le texte replié doivent désigner les mêmes lettres dans le texte affiché.
 */
export function foldForMatch(text: string): string {
  // Le cas courant, sans accent, se replie d'un coup sans changer de longueur.
  if (/^[\x00-\x7f]*$/.test(text)) return text.toLowerCase()
  let folded = ''
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string
    folded += char.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()[0] ?? char
  }
  return folded
}

/**
 * Mots de la saisie, chacun cherché séparément : l'ordre des mots ne compte pas. Une
 * barre oblique sépare aussi, comme dans VS Code : « web/pal » cherche `web` dans le
 * dossier et `pal` dans le nom du fichier.
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
 * Début de mot : après un séparateur, ou sur la bosse d'un nom en camelCase. C'est là
 * qu'on vise quand on tape des initiales.
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

/** Un début de mot sépare-t-il ces deux positions ? */
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
 * Départage des correspondances de même qualité : la plus proche du début, puis la plus
 * courte. Plafonné pour ne jamais valoir une lettre de mieux placée.
 */
function tieBreak(first: number, length: number): number {
  return -Math.min(first, 30) * 0.02 - Math.min(length, 200) * 0.002
}

function accept(score: number, positions: number[], length: number): FuzzyMatch | null {
  if (score < positions.length * minimumPerLetter(length)) return null
  return { score: score + tieBreak(positions[0] ?? 0, length), positions }
}

/**
 * Les lettres de `token` apparaissent-elles dans l'ordre ? Filtre avant tout calcul, que
 * le serveur emploie aussi pour écarter d'un coup les milliers de chemins hors course.
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
 * Tables de l'alignement, réutilisées d'un appel à l'autre : une frappe en aligne des
 * centaines, et autant d'allocations nourriraient le ramasse-miettes pour rien.
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
 * Façon de chercher un mot dans un champ.
 *
 * - `fuzzy` : lettres dans l'ordre, où qu'elles soient. Pour un identifiant court, nom de
 *   fichier ou de skill, où « cmdpal » doit retrouver « CommandPalette ».
 * - `words` : un morceau d'un seul tenant n'importe où, puis des sauts vers des débuts de
 *   mot seulement. Pour une phrase, où les lettres éparpillées se trouvent toujours et ne
 *   disent rien, mais où « aocf » doit retrouver « Add offline caching for ».
 * - `strict` : un seul morceau d'un seul tenant. Pour une description, ou un nom de projet
 *   porté en contexte.
 */
export type FuzzyMode = 'fuzzy' | 'words' | 'strict'

/**
 * Meilleur alignement par programmation dynamique : le premier venu, lettre après
 * lettre, retient le premier « p » de « apps/web/CommandPalette » et rate la bosse de
 * « Palette ». `best[j][i]` vaut le meilleur score des `j + 1` premières lettres quand
 * la dernière tombe sur `i`.
 *
 * Le coût d'un saut étant affine en sa longueur, le meilleur départ se tient à jour au
 * fil de la ligne, un par pente : l'ensemble reste linéaire par lettre de la saisie.
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
    // Départs d'un saut au milieu d'un mot : depuis ce même mot seulement, d'où la
    // remise à zéro à chaque début de mot.
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
      // Départs possibles d'un saut vers `i` : toutes les positions jusqu'à `i - 2`.
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

/** Premier alignement venu, pour les textes trop longs pour l'alignement optimal. */
function greedy(text: string, folded: string, token: string, words: boolean): FuzzyMatch | null {
  const positions: number[] = []
  let score = 0
  let at = 0
  for (const char of token) {
    const last = positions.at(-1)
    let found = folded.indexOf(char, at)
    // Mêmes sauts permis que dans l'alignement : vers un début de mot, ou plus loin dans
    // le même mot quand le mode le permet.
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
 * Occurrence d'un seul tenant, la mieux placée : un début de mot plutôt qu'un milieu,
 * puis la plus proche du début.
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

/** Un mot de la saisie, déjà replié par `fuzzyTokens`, contre un texte. */
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
  /** Part du score que ce champ transmet : le titre compte plus que la description. */
  weight: number
  mode?: FuzzyMode
  /** Repli du texte, quand l'appelant le garde d'une frappe à l'autre. */
  folded?: string
}

export interface FieldsMatch {
  score: number
  /** Positions trouvées, par champ, dans l'ordre des champs donnés. */
  positions: number[][]
  /** Champs qui ont porté au moins un mot de la saisie. */
  matched: boolean[]
}

/**
 * Tous les mots doivent se trouver, chacun dans le champ où il vaut le plus : « nimbus
 * cache » trouve une conversation de Nimbus dont le titre parle de cache.
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

  // Deux mots peuvent retenir les mêmes lettres : « ca cach » dans « caching ».
  const unique = positions.map((list) => [...new Set(list)].sort((a, b) => a - b))
  return { score, positions: unique, matched }
}
