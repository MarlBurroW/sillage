import MarkdownIt from 'markdown-it'
import { sessionReference, sessionReferenceRanges } from '@sillage/protocol'
import type Token from 'markdown-it/lib/token.mjs'
import { VIEWABLE_IMAGE_TYPES, cardReferenceRanges } from '@sillage/protocol'
import { rawFileUrl } from './files-io'
import type { WorkspaceScope } from './workspace-scope'

/**
 * Markdown rendering: markdown-it produces the structure, while code blocks and tables are
 * extracted for React rendering. Their toolbars (copy, download, wrapping, CSV export) require
 * state; rebuilding them manually in the DOM afterward, as the original copy button did, no longer
 * works.
 */

/**
 * `html: false` escapes raw model HTML instead of interpreting it. This is the only protection
 * needed here and is preferable to sanitizing afterward.
 */
const md = new MarkdownIt({ html: false, linkify: true, breaks: true })

/**
 * Automatically detect only links with a scheme. linkify-it's fuzzy mode links anything resembling
 * `name.tld`, but `.md`, `.sh`, `.io`, and `.ts` are real top-level domains: CLAUDE.md became a
 * link to `http://claude.md`, outside Sillage's control. For messages constantly citing files, this
 * rule is especially error-prone and sends users elsewhere. As a tradeoff, `github.com/org/repo`
 * without `https://` remains text. Models write complete URLs, and copying a URL is preferable to a
 * filename leading elsewhere.
 */
md.linkify.set({ fuzzyLink: false })

/** Checkbox marker at the start of a list item, following GitHub conventions. */
const TASK_MARKER = /^\[([ xX])\]\s+/

/**
 * Task-list checkboxes. markdown-it does not implement this extension: the marker remains plain
 * text at the start of the item's first paragraph. Replace it with a real disabled checkbox because
 * the thread is read-only.
 */
md.core.ruler.push('sg_task_lists', (state) => {
  const tokens = state.tokens

  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i]?.type !== 'list_item_open') continue

    // Item content starts with a paragraph whose `inline` token carries the text. An empty item
    // lacks this structure.
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
 * Content in a code span worth submitting to the server. Deliberately broad coarse filter: it only
 * avoids shell commands and URLs, leaving the workspace to decide what is a file. Shape proves
 * nothing: `text/plain`, `fs/promises`, and `@sillage/protocol` all resemble paths. Accept and
 * strip `:12` or `:12:5` grep location suffixes: the path exists, but the location is not passed to
 * the editor.
 */
const PATH_CANDIDATE = /^(?!-)(?!\w+:\/\/)[\w./@+-]{1,300}$/
const LINE_SUFFIX = /:\d+(?::\d+)?$/

/** Path carried by a code span, or null if it cannot be one. */
function pathCandidate(content: string): string | null {
  // Strip the written `./` prefix: the workspace expects a path relative to its root.
  const path = content.replace(LINE_SUFFIX, '').replace(/^\.\//, '')
  if (!PATH_CANDIDATE.test(path)) return null
  // A path with no separator or extension is a word: `useState`, `null`, `main`. This excludes
  // `Makefile` and `LICENSE` unless written with their directory; otherwise every backticked word
  // in a sentence would reach the server.
  if (!path.includes('/') && !/\.\w{1,10}$/.test(path)) return null
  // A `.` or `..` segment leaves the workspace or identifies nothing within it.
  if (/(^|\/)\.\.?($|\/)/.test(path)) return null
  return path
}

/**
 * Link or image target that cannot name a file: it has a scheme (`https:`, `mailto:`), is
 * protocol-relative, or is an anchor.
 */
const NON_PATH_TARGET = /^(\w+:|\/\/|#)/

/**
 * Path carried by a link or image target, or null if it leads elsewhere. Decode markdown-it's
 * percent-encoded target (spaces become `%20`) before checking it; otherwise `PATH_CANDIDATE`
 * rejects paths with spaces and the editor receives a path different from the one on disk. `base`
 * is the document's directory when available: in an editor document, `[before](capture.png)` refers
 * to the neighboring screenshot rather than the workspace root. This matches GitHub and the
 * authoring agent's convention.
 */
function pathTarget(target: string | null, base?: string): string | null {
  if (!target || NON_PATH_TARGET.test(target)) return null
  let decoded = target
  try {
    decoded = decodeURI(target)
  } catch {
    // Invalid escape sequence: use the target as written.
  }
  if (base !== undefined && !decoded.startsWith('/')) {
    const joined = joinPath(base, decoded)
    if (joined === null) return null
    decoded = joined
  }
  return pathCandidate(decoded)
}

/**
 * Resolve `target` from directory `base`, including `.` and `..`. Return null if it climbs above a
 * relative base: it would leave the workspace and the server would reject it anyway.
 */
function joinPath(base: string, target: string): string | null {
  const absolute = base.startsWith('/')
  const segments = base.split('/').filter(Boolean)
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment !== '..') segments.push(segment)
    else if (segments.pop() === undefined && !absolute) return null
  }
  return `${absolute ? '/' : ''}${segments.join('/')}`
}

/** A type served as an image by `file/raw`; other types have nothing to display. */
function isViewableImage(path: string): boolean {
  const extension = path.split('.').pop()?.toLowerCase() ?? ''
  return extension in VIEWABLE_IMAGE_TYPES
}

/**
 * Make code spans, links, and images naming workspace files clickable. Only paths in `known` are
 * transformed: rendering applies an existing answer instead of deciding. Without `known`, this pass
 * merely collects candidates for the caller to submit. An attribute carries the path and a
 * delegated listener opens the tab: injected HTML has no React component for `onClick`. Mark
 * unconfirmed link or image targets `data-sg-drop` to render them as text. Browsers interpret `<a
 * href="/home/…">` as a site path, which would leave Sillage for a nonexistent page. Inert text is
 * preferable to a misleading link, as with `fuzzyLink: false`.
 */
function markFilePaths(md: MarkdownIt): void {
  md.core.ruler.push('sg_file_paths', (state) => {
    const env = state.env as MarkdownEnv

    /** Mark a token carrying a path and indicate whether it was confirmed. */
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
          // An unconfirmed code span remains a code span: it was never clickable, so nothing needs removing.
          if (path) {
            env.candidates?.add(path)
            if (env.knownFiles?.has(path)) child.attrSet('data-sg-path', path)
          }
          continue
        }

        if (child.type === 'image') {
          const path = pathTarget(child.attrGet('src'), env.base)
          if (!path) continue
          if (!mark(child, path)) continue

          // Use the workspace read URL as the source: a disk path is not a browser-accessible
          // address. Without a scope, or for a type rejected by the read route, render a clickable
          // path rather than a broken image; `![x](notes.md)` is valid input.
          if (env.scope && isViewableImage(path)) {
            child.attrSet('src', rawFileUrl(env.scope, path))
          } else {
            child.attrSet('data-sg-flat', '')
          }
          continue
        }

        if (child.type === 'link_open') {
          const path = pathTarget(child.attrGet('href'), env.base)
          if (!path) continue
          const known = mark(child, path)
          // Links cannot nest: the first closing token belongs to this link. Mark it too so
          // rendering knows which tag to close.
          const close = children.slice(i + 1).find((next) => next.type === 'link_close')
          close?.attrSet(known ? 'data-sg-path' : 'data-sg-drop', '')
        }
      }
    }
    return true
  })

  /**
   * Outgoing links must not be able to manipulate the Sillage tab. Links naming files become
   * buttons, like cited paths.
   */
  md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
    const token = tokens[idx]
    if (!token) return ''

    const path = token.attrGet('data-sg-path')
    // Use a button instead of a rewritten `<a>`: keyboard-accessible and announced as an action,
    // without an href the browser could follow.
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
   * Show workspace images directly in the thread: they are usually screenshots, and the wrapping
   * button still allows opening them with one click. An unconfirmed source retains alt text instead
   * of displaying a broken image.
   */
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    if (!token) return ''

    const alt = self.renderInlineAsText(token.children ?? [], options, env)
    if (token.attrGet('data-sg-drop') !== null) return md.utils.escapeHtml(alt)

    const path = token.attrGet('data-sg-path')
    if (path === null) {
      token.attrSet('alt', alt)
      return `<button type="button" class="sg-file-image">${self.renderToken(tokens, idx, options)}</button>`
    }

    // Confirmed but undisplayable file: use the same button as for a cited path, labeled with alt
    // text when available, otherwise the path.
    if (token.attrGet('data-sg-flat') !== null) {
      const label = md.utils.escapeHtml(alt || path)
      return `<button type="button" class="sg-file" data-sg-path="${md.utils.escapeHtml(path)}">${label}</button>`
    }

    token.attrSet('alt', alt)
    // The marker belongs to the wrapping button, not the image itself.
    token.attrs = (token.attrs ?? []).filter(([name]) => name !== 'data-sg-path')
    return (
      `<button type="button" class="sg-file-image" data-sg-path="${md.utils.escapeHtml(path)}">` +
      `<img${self.renderAttrs(token)}>` +
      '</button>'
    )
  }

  /**
   * Render a confirmed path as a button rather than clickable `<code>`: this provides keyboard
   * access and action semantics that a listener on an inert element cannot provide.
   */
  md.renderer.rules.code_inline = (tokens, idx, _options, _env, self) => {
    const token = tokens[idx]
    const content = md.utils.escapeHtml(token?.content ?? '')
    if (!token?.attrGet('data-sg-path')) return `<code>${content}</code>`

    return `<button type="button" class="sg-file"${self.renderAttrs(token)}>${content}</button>`
  }
}

/** Reference slots mount React links that share the sidebar's session details. */
function markSessionReferences(md: MarkdownIt): void {
  md.core.ruler.push('sg_session_refs', state => {
    const env = state.env as MarkdownEnv
    if (!env.projectId) return
    const ranges = (value: string) => sessionReferenceRanges(value, env.origin)
      .filter(ref => (env.projectId === null || !ref.projectId || ref.projectId === env.projectId) && (ref.explicit || env.sessionIds?.has(ref.id)))
    const slot = (id: string) => {
      const token = new state.Token('html_inline', '', 0)
      token.meta = { sessionReference: sessionReference(id) }
      token.content = '<span data-sg-session-ref="' + md.utils.escapeHtml(id) + '"></span>'
      return token
    }
    for (const token of state.tokens) {
      if (token.type !== 'inline' || !token.children) continue
      const children: Token[] = []
      let inLink = 0
      for (let index = 0; index < token.children.length; index++) {
        const child = token.children[index]!
        if (child.type === 'link_open') {
          const href = child.attrGet('href') ?? ''
          const reference = ranges(href).find(ref => ref.start === 0 && ref.end === href.length)
          const close = token.children.findIndex((next, i) => i > index && next.type === 'link_close')
          if (reference && close !== -1) {
            children.push(slot(reference.id))
            index = close
            continue
          }
          inLink++
        }
        if (child.type === 'link_close') inLink--
        const found = inLink === 0 && (child.type === 'text' || child.type === 'code_inline') ? ranges(child.content) : []
        // Code containing commands remains copyable code.
        if (!found.length || (child.type === 'code_inline' && (found.length !== 1 || found[0]!.start !== 0 || found[0]!.end !== child.content.length))) {
          children.push(child)
          continue
        }
        let at = 0
        const text = (content: string) => {
          if (!content) return
          const plain = new state.Token('text', '', 0)
          plain.content = content
          children.push(plain)
        }
        for (const ref of found) {
          text(child.content.slice(at, ref.start))
          children.push(slot(ref.id))
          at = ref.end
        }
        text(child.content.slice(at))
      }
      token.children = children
    }
  })
}
markSessionReferences(md)
markFilePaths(md)

/**
 * Make `#12` references to board cards clickable. Only numbers in `cards` are transformed, like
 * file paths: issue numbers from other repositories or missing cards remain text rather than
 * linking to the wrong card. Never modify code or links, only text tokens outside links. The button
 * carries the number; a delegated listener opens and previews the card.
 */
function markCardReferences(md: MarkdownIt): void {
  md.core.ruler.push('sg_card_refs', (state) => {
    const known = (state.env as MarkdownEnv).cards
    if (!known || known.size === 0) return true

    const text = (content: string): Token => {
      const token = new state.Token('text', '', 0)
      token.content = content
      return token
    }

    for (const token of state.tokens) {
      if (token.type !== 'inline' || !token.children) continue
      const children: Token[] = []
      let inLink = 0
      for (const child of token.children) {
        if (child.type === 'link_open') inLink += 1
        if (child.type === 'link_close') inLink -= 1
        const ranges = child.type === 'text' && inLink === 0
          ? cardReferenceRanges(child.content).filter((range) => known.has(range.number))
          : []
        if (ranges.length === 0) {
          children.push(child)
          continue
        }
        let at = 0
        for (const range of ranges) {
          if (range.start > at) children.push(text(child.content.slice(at, range.start)))
          const button = new state.Token('html_inline', '', 0)
          button.content = `<button type="button" class="sg-card-ref" data-sg-card="${range.number}">#${range.number}</button>`
          children.push(button)
          at = range.end
        }
        if (at < child.content.length) children.push(text(child.content.slice(at)))
      }
      token.children = children
    }
    return true
  })
}

markCardReferences(md)

/** Inputs and outputs of the rendering pass. */
interface MarkdownEnv {
  sessionIds?: Pick<ReadonlySet<string>, 'has'>
  projectId?: string | null
  origin?: string
  /** Potential paths encountered, to submit to the server. */
  candidates?: Set<string>
  /** Paths the server confirmed as files. */
  knownFiles?: Set<string>
  /**
   * Scope of these paths, used to build image read URLs. Absent outside conversations: disk images
   * then remain alt text.
   */
  scope?: WorkspaceScope
  /** Rendered document's directory, the base for relative links. See `pathTarget`. */
  base?: string
  /** Card numbers from the board associated with the text. See `markCardReferences`. */
  cards?: Set<number>
}

/** Content segment to be rendered by the React component. */
export type MarkdownSegment =
  | { kind: 'html'; html: string }
  | { kind: 'code'; language: string; code: string }
  | { kind: 'table'; html: string; rows: string[][] }

export interface MarkdownDocument {
  segments: MarkdownSegment[]
  /** Potential paths in the document, whether made clickable or not. */
  candidates: Set<string>
}

/** Cell text with markup removed, for CSV export. */
function cellText(inline: Token | undefined): string {
  if (!inline?.children) return inline?.content ?? ''
  return inline.children
    .filter((child) => child.type === 'text' || child.type === 'code_inline' || child.meta?.sessionReference)
    .map((child) => child.meta?.sessionReference ?? child.content)
    .join('')
    .trim()
}

/** Table cells in row order, including the header. */
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
 * Split the document into segments. Render tokens outside code blocks and tables together through
 * markdown-it, rather than individually: this is the only way to preserve its exact HTML output.
 */
export function parseMarkdown(
  text: string,
  options: Omit<MarkdownEnv, 'candidates'> = {},
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
        // `info` may contain metadata after the language (`ts title=...`).
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
