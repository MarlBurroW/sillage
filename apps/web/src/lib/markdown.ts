import MarkdownIt from 'markdown-it'
import type Token from 'markdown-it/lib/token.mjs'
import { VIEWABLE_IMAGE_TYPES } from '@sillage/protocol'
import { rawFileUrl } from './files-io'
import type { WorkspaceScope } from './workspace-scope'

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

/**
 * Seuls les liens portant un schéma sont détectés automatiquement.
 *
 * Le mode approximatif de linkify-it lie tout ce qui ressemble à `nom.tld` sans schéma,
 * or `.md`, `.sh`, `.io` ou `.ts` sont de vrais domaines de premier niveau : « CLAUDE.md »
 * devenait un lien vers `http://claude.md`, un domaine que Sillage ne contrôle pas. Dans
 * un outil où l'on cite des fichiers à longueur de message, c'est la règle qui se trompe
 * le plus souvent, et elle se trompe vers l'extérieur.
 *
 * Le prix est qu'un `github.com/org/depot` écrit sans `https://` reste du texte. Les
 * modèles écrivent des URL complètes, et une URL qu'il faut copier vaut mieux qu'un nom
 * de fichier qui emmène ailleurs.
 */
md.linkify.set({ fuzzyLink: false })

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

/**
 * Ce qui, dans un `code span`, peut valoir la peine d'être soumis au serveur.
 *
 * Filtre grossier et volontairement large : il ne tranche pas, il évite seulement
 * d'envoyer des commandes shell et des URL. C'est le workspace qui dit ensuite ce qui
 * est un fichier, parce que la forme ne prouve rien : `text/plain`, `fs/promises` et
 * `@sillage/protocol` ressemblent tous à des chemins.
 *
 * Le suffixe `:12` ou `:12:5` des sorties de `grep` est toléré et retiré : le chemin
 * qu'il désigne existe, seule la position ne se transmet pas à l'éditeur.
 */
const PATH_CANDIDATE = /^(?!-)(?!\w+:\/\/)[\w./@+-]{1,300}$/
const LINE_SUFFIX = /:\d+(?::\d+)?$/

/** Chemin porté par un `code span`, ou null s'il ne peut pas en être un. */
function pathCandidate(content: string): string | null {
  // Le `./` d'écriture est retiré, le workspace attend un chemin relatif à sa racine.
  const path = content.replace(LINE_SUFFIX, '').replace(/^\.\//, '')
  if (!PATH_CANDIDATE.test(path)) return null
  // Un chemin sans séparateur ni extension est un mot : `useState`, `null`, `main`.
  // `Makefile` et `LICENSE` y perdent, sauf écrits avec leur dossier ; l'inverse
  // enverrait au serveur chaque mot mis entre accents graves dans une phrase.
  if (!path.includes('/') && !/\.\w{1,10}$/.test(path)) return null
  // Un segment `.` ou `..` sort du workspace, ou n'y désigne rien.
  if (/(^|\/)\.\.?($|\/)/.test(path)) return null
  return path
}

/**
 * Cible d'un lien ou d'une image qui ne peut pas désigner un fichier : elle porte un
 * schéma (`https:`, `mailto:`), elle est protocole-relative, ou c'est une ancre.
 */
const NON_PATH_TARGET = /^(\w+:|\/\/|#)/

/**
 * Chemin porté par la cible d'un lien ou d'une image, ou null si elle mène ailleurs.
 *
 * markdown-it encode la cible en pourcent (un espace devient `%20`) : elle est décodée
 * avant d'être jugée, sinon un chemin avec espace serait recalé par `PATH_CANDIDATE`,
 * et le chemin transmis à l'éditeur ne serait pas celui du disque.
 */
function pathTarget(target: string | null): string | null {
  if (!target || NON_PATH_TARGET.test(target)) return null
  let decoded = target
  try {
    decoded = decodeURI(target)
  } catch {
    // Séquence d'échappement invalide : la cible est prise telle qu'écrite.
  }
  return pathCandidate(decoded)
}

/** Un type que `file/raw` sert comme image : les autres n'ont rien à afficher. */
function isViewableImage(path: string): boolean {
  const extension = path.split('.').pop()?.toLowerCase() ?? ''
  return extension in VIEWABLE_IMAGE_TYPES
}

/**
 * Rend cliquables les `code spans`, liens et images qui désignent un fichier du
 * workspace.
 *
 * Seuls les chemins de `known` sont transformés : le rendu ne décide de rien, il
 * applique une réponse déjà obtenue. Sans `known`, la passe ne fait que collecter les
 * candidats, que l'appelant soumettra.
 *
 * L'attribut porte le chemin, et c'est un écouteur délégué qui ouvre l'onglet : le HTML
 * est injecté tel quel, il n'y a pas de composant React où accrocher un `onClick`.
 *
 * Un lien ou une image dont la cible est un chemin non confirmé est marqué `data-sg-drop` :
 * il sera rendu en texte. Un `<a href="/home/…">` est lu par le navigateur comme un
 * chemin du site : le clic sortirait de Sillage vers une page qui n'existe pas. Du texte
 * inerte vaut mieux qu'un lien qui emmène ailleurs — c'est la même règle que
 * `fuzzyLink: false`.
 */
function markFilePaths(md: MarkdownIt): void {
  md.core.ruler.push('sg_file_paths', (state) => {
    const env = state.env as MarkdownEnv

    /** Marque un token porteur d'un chemin, et dit s'il a été confirmé. */
    const mark = (token: Token, path: string): boolean => {
      env.candidates?.add(path)
      if (env.knownFiles?.has(path)) {
        token.attrSet('data-sg-path', path)
        return true
      }
      token.attrSet('data-sg-drop', '')
      return false
    }

    for (const token of state.tokens) {
      if (token.type !== 'inline') continue

      const children = token.children ?? []
      for (let i = 0; i < children.length; i += 1) {
        const child = children[i]
        if (!child) continue

        if (child.type === 'code_inline') {
          const path = pathCandidate(child.content)
          // Un `code span` non confirmé reste un `code span` : il n'a jamais été
          // cliquable, il n'y a rien à retirer.
          if (path) {
            env.candidates?.add(path)
            if (env.knownFiles?.has(path)) child.attrSet('data-sg-path', path)
          }
          continue
        }

        if (child.type === 'image') {
          const path = pathTarget(child.attrGet('src'))
          if (!path) continue
          if (!mark(child, path)) continue

          // La source devient l'URL de lecture du workspace : le chemin du disque n'est
          // pas une adresse que le navigateur sait atteindre. Sans portée pour la
          // construire, ou pour un type que la route de lecture refuse, l'image se rend
          // en chemin cliquable plutôt qu'en icône cassée : `![x](notes.md)` s'écrit.
          if (env.scope && isViewableImage(path)) {
            child.attrSet('src', rawFileUrl(env.scope, path))
          } else {
            child.attrSet('data-sg-flat', '')
          }
          continue
        }

        if (child.type === 'link_open') {
          const path = pathTarget(child.attrGet('href'))
          if (!path) continue
          const known = mark(child, path)
          // Les liens ne s'imbriquent pas : la première fermeture est la sienne. Elle
          // porte la même marque, faute de quoi le rendu ne saurait pas quelle balise
          // refermer.
          const close = children.slice(i + 1).find((next) => next.type === 'link_close')
          close?.attrSet(known ? 'data-sg-path' : 'data-sg-drop', '')
        }
      }
    }
    return true
  })

  /**
   * Les liens sortants ne doivent pas pouvoir manipuler l'onglet de Sillage. Ceux qui
   * désignent un fichier deviennent des boutons, comme les chemins cités.
   */
  md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
    const token = tokens[idx]
    if (!token) return ''

    const path = token.attrGet('data-sg-path')
    // Un bouton plutôt qu'un `<a>` réécrit : il est atteignable au clavier et annoncé
    // comme une action, et il n'a pas de `href` que le navigateur pourrait suivre.
    if (path !== null) {
      return `<button type="button" class="sg-file" data-sg-path="${md.utils.escapeHtml(path)}">`
    }
    if (token.attrGet('data-sg-drop') !== null) return ''

    token.attrSet('target', '_blank')
    token.attrSet('rel', 'noopener noreferrer')
    return self.renderToken(tokens, idx, options)
  }

  md.renderer.rules.link_close = (tokens, idx, options, _env, self) => {
    const token = tokens[idx]
    if (!token) return ''
    if (token.attrGet('data-sg-path') !== null) return '</button>'
    if (token.attrGet('data-sg-drop') !== null) return ''
    return self.renderToken(tokens, idx, options)
  }

  /**
   * Une image du workspace est montrée dans le fil, et non pas seulement liée : c'est
   * une capture d'écran neuf fois sur dix, et l'ouvrir en un clic reste possible par le
   * bouton qui l'enveloppe. Une source non confirmée n'affiche pas d'image cassée : il
   * reste le texte alternatif.
   */
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    if (!token) return ''

    const alt = self.renderInlineAsText(token.children ?? [], options, env)
    if (token.attrGet('data-sg-drop') !== null) return md.utils.escapeHtml(alt)

    const path = token.attrGet('data-sg-path')
    if (path === null) return self.renderToken(tokens, idx, options)

    // Fichier confirmé mais pas affichable : le même bouton que pour un chemin cité,
    // portant le texte alternatif quand il y en a un, le chemin sinon.
    if (token.attrGet('data-sg-flat') !== null) {
      const label = md.utils.escapeHtml(alt || path)
      return `<button type="button" class="sg-file" data-sg-path="${md.utils.escapeHtml(path)}">${label}</button>`
    }

    token.attrSet('alt', alt)
    // La marque vit sur le bouton qui enveloppe l'image, pas sur l'image elle-même.
    token.attrs = (token.attrs ?? []).filter(([name]) => name !== 'data-sg-path')
    return (
      `<button type="button" class="sg-file-image" data-sg-path="${md.utils.escapeHtml(path)}">` +
      `<img${self.renderAttrs(token)}>` +
      '</button>'
    )
  }

  /**
   * Un chemin confirmé se rend en bouton, pas en `<code>` cliquable : il est alors
   * atteignable au clavier et annoncé comme une action, ce qu'un écouteur posé sur un
   * élément inerte ne donne pas.
   */
  md.renderer.rules.code_inline = (tokens, idx, _options, _env, self) => {
    const token = tokens[idx]
    const content = md.utils.escapeHtml(token?.content ?? '')
    if (!token?.attrGet('data-sg-path')) return `<code>${content}</code>`

    return `<button type="button" class="sg-file"${self.renderAttrs(token)}>${content}</button>`
  }
}

markFilePaths(md)

/** Ce que la passe de rendu reçoit et remplit. */
interface MarkdownEnv {
  /** Chemins possibles rencontrés, à soumettre au serveur. */
  candidates?: Set<string>
  /** Chemins dont le serveur a confirmé qu'ils sont des fichiers. */
  knownFiles?: Set<string>
  /**
   * Portée dont les chemins relèvent, pour construire l'URL de lecture des images.
   * Absente hors conversation : une image du disque reste alors son texte alternatif.
   */
  scope?: WorkspaceScope
}

/** Un segment de contenu, tel que le composant React doit le rendre. */
export type MarkdownSegment =
  | { kind: 'html'; html: string }
  | { kind: 'code'; language: string; code: string }
  | { kind: 'table'; html: string; rows: string[][] }

export interface MarkdownDocument {
  segments: MarkdownSegment[]
  /** Chemins possibles du document, qu'ils aient été rendus cliquables ou non. */
  candidates: Set<string>
}

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
export function parseMarkdown(
  text: string,
  options: { knownFiles?: Set<string>; scope?: WorkspaceScope } = {},
): MarkdownDocument {
  const candidates = new Set<string>()
  const env: MarkdownEnv = { candidates, ...options }
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
  return { segments, candidates }
}
