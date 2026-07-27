import MarkdownIt from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'

/**
 * Rendu markdown : markdown-it produit la structure, mais les blocs de code et les
 * tableaux sont extraits pour être rendus par React.
 *
 * Ces deux-là portent une barre d'outils (copie, téléchargement, retour à la ligne,
 * export CSV) : les recréer à la main dans le DOM après coup, comme le faisait le
 * bouton de copie d'origine, ne tient plus dès qu'il y a un état à gérer.
 */

/**
 * `html: false` : le HTML brut du modèle est échappé, pas interprété. C'est la seule
 * protection nécessaire ici, et elle vaut mieux qu'un assainisseur ajouté après coup.
 */
const md = new MarkdownIt({ html: false, linkify: true, breaks: true })

// Les liens sortants ne doivent pas pouvoir manipuler l'onglet de Sillage.
md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
  tokens[idx]?.attrSet('target', '_blank')
  tokens[idx]?.attrSet('rel', 'noopener noreferrer')
  return self.renderToken(tokens, idx, options)
}

/** Marqueur de case à cocher en tête d'élément de liste, à la façon de GitHub. */
const TASK_MARKER = /^\[([ xX])\]\s+/

/**
 * Cases à cocher des listes de tâches.
 *
 * markdown-it ne connaît pas cette extension : le marqueur reste du texte brut au
 * début du premier paragraphe de l'élément. On le retire du texte et on le remplace
 * par une vraie case, désactivée puisque le fil n'est pas modifiable.
 */
md.core.ruler.push('sg_task_lists', (state) => {
  const tokens = state.tokens

  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i]?.type !== 'list_item_open') continue

    // Le contenu de l'élément commence par un paragraphe, dont le token `inline`
    // porte le texte. Un élément vide n'a pas cette structure.
    const inline = tokens[i + 2]
    if (inline?.type !== 'inline') continue

    const first = inline.children?.[0]
    if (first?.type !== 'text') continue

    const match = TASK_MARKER.exec(first.content)
    if (!match) continue

    first.content = first.content.slice(match[0].length)
    tokens[i]?.attrJoin('class', 'sg-task-item')

    const checkbox = new state.Token('html_inline', '', 0)
    checkbox.content = `<input type="checkbox" disabled${match[1] === ' ' ? '' : ' checked'}>`
    inline.children?.unshift(checkbox)
  }

  return true
})

/** Un segment de contenu, tel que le composant React doit le rendre. */
export type MarkdownSegment =
  | { kind: 'html'; html: string }
  | { kind: 'code'; language: string; code: string }
  | { kind: 'table'; html: string; rows: string[][] }

/** Texte d'une cellule, débarrassé de son balisage, pour l'export CSV. */
function cellText(inline: Token | undefined): string {
  if (!inline?.children) return inline?.content ?? ''
  return inline.children
    .filter((child) => child.type === 'text' || child.type === 'code_inline')
    .map((child) => child.content)
    .join('')
    .trim()
}

/** Cellules d'un tableau, dans l'ordre des lignes, en-tête compris. */
function tableRows(tokens: Token[], start: number, end: number): string[][] {
  const rows: string[][] = []
  let current: string[] | null = null

  for (let i = start; i < end; i += 1) {
    const token = tokens[i]
    if (!token) continue

    if (token.type === 'tr_open') {
      current = []
    } else if (token.type === 'tr_close') {
      if (current) rows.push(current)
      current = null
    } else if (token.type === 'th_open' || token.type === 'td_open') {
      current?.push(cellText(tokens[i + 1]))
    }
  }

  return rows
}

/**
 * Découpe le document en segments. Les tokens qui ne relèvent ni d'un bloc de code ni
 * d'un tableau sont rendus en bloc par markdown-it, plutôt qu'un par un : c'est le
 * seul moyen de garder son HTML exactement tel qu'il le produit.
 */
export function parseMarkdown(text: string): MarkdownSegment[] {
  const env = {}
  const tokens = md.parse(text, env)
  const segments: MarkdownSegment[] = []

  let htmlStart = 0
  const flushHtml = (end: number) => {
    if (end <= htmlStart) return
    const html = md.renderer.render(tokens.slice(htmlStart, end), md.options, env)
    if (html.trim()) segments.push({ kind: 'html', html })
  }

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (!token) continue

    if (token.type === 'fence') {
      flushHtml(i)
      segments.push({
        kind: 'code',
        // `info` peut porter des métadonnées après le langage (`ts title=...`).
        language: token.info.trim().split(/\s+/)[0] ?? '',
        code: token.content.replace(/\n$/, ''),
      })
      htmlStart = i + 1
      continue
    }

    if (token.type === 'table_open') {
      const close = tokens.findIndex((entry, index) => index > i && entry.type === 'table_close')
      if (close === -1) continue

      flushHtml(i)
      segments.push({
        kind: 'table',
        html: md.renderer.render(tokens.slice(i, close + 1), md.options, env),
        rows: tableRows(tokens, i, close + 1),
      })
      htmlStart = close + 1
      i = close
    }
  }

  flushHtml(tokens.length)
  return segments
}
