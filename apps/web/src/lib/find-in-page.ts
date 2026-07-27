/**
 * Recherche dans le fil affiché.
 *
 * Travaille sur le DOM et non sur les éléments du fold : c'est le seul moyen de
 * trouver aussi ce que produit le rendu markdown et le contenu des appels d'outils,
 * et ça donne directement les plages dont l'API de surlignage a besoin.
 */

/** Un segment de texte du conteneur, avec sa position dans le texte reconstitué. */
interface Segment {
  node: Text
  /** Index du début de ce nœud dans la chaîne repliée. */
  start: number
  /** Index d'origine de chaque caractère replié, pour revenir aux offsets du nœud. */
  offsets: number[]
}

/**
 * Replie un texte pour la comparaison : minuscules et sans accents.
 *
 * Le repli est fait caractère par caractère et non sur la chaîne entière : « é » se
 * décompose en deux caractères, donc une normalisation globale décalerait toutes les
 * positions suivantes et le surlignage tomberait à côté.
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

/** Reconstitue le texte visible du conteneur, en gardant le lien vers les nœuds. */
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

/** Nœud et offset correspondant à une position de la chaîne repliée. */
function locate(segments: Segment[], position: number): { node: Text; offset: number } | null {
  // Recherche dichotomique : un fil long porte des milliers de nœuds, et les parcourir
  // pour chaque borne de chaque correspondance se sentirait à la frappe.
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

  // Position en fin de segment : c'est le cas d'une borne de fin, qui vaut la longueur
  // du nœud plutôt qu'un index dedans.
  const last = segments.at(-1)
  return last ? { node: last.node, offset: last.node.nodeValue?.length ?? 0 } : null
}

/**
 * Toutes les occurrences de `query` dans le conteneur, en plages DOM.
 *
 * Les correspondances qui traversent plusieurs nœuds sont trouvées : le texte est
 * reconstitué d'un bloc, donc un terme coupé par un `<strong>` compte comme les autres.
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

/** Vrai si le navigateur sait surligner des plages sans toucher au document. */
export function supportsHighlight(): boolean {
  return typeof CSS !== 'undefined' && 'highlights' in CSS
}
