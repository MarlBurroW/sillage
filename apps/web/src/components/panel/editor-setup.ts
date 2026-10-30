import {
  HighlightStyle,
  LanguageSupport,
  syntaxHighlighting,
  type StreamParser,
} from '@codemirror/language'
import { Annotation, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view'
import { tags } from '@lezer/highlight'

/**
 * CodeMirror styled with Sillage tokens. Imported themes would clash; use the thread's syntax
 * variables so theme and hue changes affect the editor too. Keep CSS var() values unresolved to
 * update themes live without rebuilding.
 */
export const editorTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: '0.8125rem',
    backgroundColor: 'var(--sg-surface)',
    color: 'var(--sg-ink)',
  },
  '.cm-scroller': {
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    lineHeight: '1.6',
  },
  '.cm-content': { caretColor: 'var(--sg-accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--sg-accent)' },
  '.cm-gutters': {
    backgroundColor: 'var(--sg-surface)',
    color: 'var(--sg-ink-faint)',
    border: 'none',
    borderRight: '1px solid var(--sg-line)',
  },
  '.cm-activeLine': { backgroundColor: 'var(--sg-surface-high)' },
  '.cm-activeLineGutter': {
    backgroundColor: 'var(--sg-surface-high)',
    color: 'var(--sg-ink-soft)',
  },
  // Without important, CodeMirror selection styling overrides the theme.
  '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--sg-accent-wash) !important' },
  '&.cm-focused': { outline: 'none' },
  '.cm-selectionMatch': { backgroundColor: 'var(--sg-accent-wash)' },
  '.cm-searchMatch': { backgroundColor: 'var(--sg-accent-wash)' },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'var(--sg-accent)',
    color: 'var(--sg-accent-ink)',
  },
  /*
   * Search panel. Native white controls clash and become unreadable in dark mode. Apply the same
   * tokens as Sillage controls.
   */
  '.cm-panels': {
    backgroundColor: 'var(--sg-surface-high)',
    color: 'var(--sg-ink)',
    borderColor: 'var(--sg-line)',
  },
  '.cm-panel.cm-search': {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '0.375rem',
    padding: '0.5rem',
    fontFamily: 'inherit',
    fontSize: '0.75rem',
  },
  '.cm-panel.cm-search label': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.25rem',
    margin: 0,
    color: 'var(--sg-ink-faint)',
  },
  '.cm-textfield': {
    height: '1.75rem',
    padding: '0 0.5rem',
    border: '1px solid var(--sg-line)',
    borderRadius: 'var(--radius-md, 0.5rem)',
    backgroundColor: 'var(--sg-sunken)',
    color: 'var(--sg-ink)',
    fontFamily: 'inherit',
    fontSize: '0.75rem',
  },
  '.cm-textfield:focus': { outline: 'none', borderColor: 'var(--sg-accent)' },
  '.cm-button': {
    height: '1.75rem',
    padding: '0 0.625rem',
    border: '1px solid var(--sg-line)',
    borderRadius: 'var(--radius-md, 0.5rem)',
    // CodeMirror's native gradient ignores the supplied background color.
    backgroundImage: 'none',
    backgroundColor: 'var(--sg-surface)',
    color: 'var(--sg-ink)',
    fontFamily: 'inherit',
    fontSize: '0.75rem',
    cursor: 'pointer',
  },
  '.cm-button:hover': { borderColor: 'var(--sg-line-strong)' },
  '.cm-button:active': { backgroundImage: 'none', backgroundColor: 'var(--sg-surface-high)' },
  '.cm-panel.cm-search [name="close"]': {
    position: 'static',
    marginLeft: 'auto',
    padding: '0 0.375rem',
    border: 'none',
    background: 'none',
    color: 'var(--sg-ink-faint)',
    fontSize: '1rem',
    cursor: 'pointer',
  },
  '.cm-panel.cm-search [name="close"]:hover': { color: 'var(--sg-ink)' },
  '.cm-foldPlaceholder': {
    backgroundColor: 'var(--sg-surface-high)',
    border: '1px solid var(--sg-line)',
    color: 'var(--sg-ink-faint)',
  },
  /*
   * Comparison with the disk (@codemirror/merge). Its base theme only knows fixed light colors and
   * outranks plain selectors: the app's tones need `!important` here, like selection above.
   */
  '.cm-changedLine, .cm-insertedLine': {
    backgroundColor: 'color-mix(in srgb, var(--sg-positive) 10%, transparent) !important',
  },
  '.cm-changedText': {
    background: 'color-mix(in srgb, var(--sg-positive) 28%, transparent) !important',
  },
  '.cm-deletedChunk': {
    position: 'relative',
    paddingLeft: '6px',
    backgroundColor: 'color-mix(in srgb, var(--sg-critical) 10%, transparent) !important',
  },
  '.cm-deletedChunk .cm-deletedText, .cm-deletedText': {
    background: 'color-mix(in srgb, var(--sg-critical) 28%, transparent) !important',
  },
  '.cm-changedLineGutter, .cm-insertedLineGutter': { background: 'var(--sg-positive) !important' },
  '.cm-deletedLineGutter': { background: 'var(--sg-critical) !important' },
  '.cm-deletedChunk .cm-chunkButtons': {
    position: 'absolute',
    top: '2px',
    insetInlineEnd: '6px',
    display: 'flex',
    gap: '4px',
  },
  '.cm-deletedChunk .cm-chunkButtons button': {
    height: '1.5rem',
    padding: '0 0.5rem',
    border: '1px solid var(--sg-line)',
    borderRadius: 'var(--radius-md, 0.5rem)',
    background: 'var(--sg-surface)',
    color: 'var(--sg-ink)',
    fontFamily: 'var(--font-sans, inherit)',
    fontSize: '0.75rem',
    cursor: 'pointer',
  },
  '.cm-deletedChunk .cm-chunkButtons button[name=accept]:hover': { borderColor: 'var(--sg-positive)' },
  '.cm-deletedChunk .cm-chunkButtons button[name=reject]:hover': { borderColor: 'var(--sg-critical)' },
})

/** Same seven syntax families as the thread: one app palette. */
export const editorHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [tags.comment, tags.lineComment, tags.blockComment], color: 'var(--sg-syn-comment)', fontStyle: 'italic' },
    {
      tag: [tags.keyword, tags.controlKeyword, tags.moduleKeyword, tags.operatorKeyword, tags.self],
      color: 'var(--sg-syn-keyword)',
    },
    { tag: [tags.string, tags.special(tags.string), tags.regexp], color: 'var(--sg-syn-string)' },
    { tag: [tags.number, tags.bool, tags.null, tags.atom], color: 'var(--sg-syn-number)' },
    {
      tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.labelName],
      color: 'var(--sg-syn-function)',
    },
    {
      tag: [tags.typeName, tags.className, tags.namespace, tags.standard(tags.typeName)],
      color: 'var(--sg-syn-type)',
    },
    {
      tag: [tags.attributeName, tags.propertyName, tags.tagName, tags.heading],
      color: 'var(--sg-syn-attribute)',
    },
  ]),
)

/**
 * Legacy CodeMirror 5 mode wrapped for version 6. Legacy modes use line parsers rather than Lezer
 * grammars, lacking folding and contextual indentation but covering shell, TOML, INI, Dockerfile,
 * and many others in one package. Approximate env-file highlighting beats plain white text. Pass
 * modules as functions, not concatenated import strings the bundler cannot analyze.
 */
function legacy(load: () => Promise<StreamParser<unknown>>): () => Promise<LanguageSupport> {
  return async () => {
    const [{ StreamLanguage }, parser] = await Promise.all([import('@codemirror/language'), load()])
    return new LanguageSupport(StreamLanguage.define(parser))
  }
}

/**
 * Load modes on demand like thread highlight.js: bundling every language would inflate initial load
 * for an optional panel. Extensions are keys; unknown ones remain uncolored rather than guessed.
 */
const LOADERS: Record<string, () => Promise<LanguageSupport>> = {
  ts: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true })),
  mts: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true })),
  cts: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true })),
  tsx: () =>
    import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true, jsx: true })),
  js: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  mjs: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  cjs: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  jsx: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })),
  json: () => import('@codemirror/lang-json').then((m) => m.json()),
  // JSON with comments (tsconfig, VS Code settings): the JSON grammar marks comments as errors.
  jsonc: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  json5: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  md: () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
  markdown: () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
  mdx: () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
  css: () => import('@codemirror/lang-css').then((m) => m.css()),
  scss: legacy(() => import('@codemirror/legacy-modes/mode/css').then((m) => m.sCSS)),
  less: legacy(() => import('@codemirror/legacy-modes/mode/css').then((m) => m.less)),
  html: () => import('@codemirror/lang-html').then((m) => m.html()),
  py: () => import('@codemirror/lang-python').then((m) => m.python()),
  rs: () => import('@codemirror/lang-rust').then((m) => m.rust()),
  yaml: () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
  yml: () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
  sql: () => import('@codemirror/lang-sql').then((m) => m.sql()),
  xml: () => import('@codemirror/lang-xml').then((m) => m.xml()),
  svg: () => import('@codemirror/lang-xml').then((m) => m.xml()),

  go: () => import('@codemirror/lang-go').then((m) => m.go()),
  php: () => import('@codemirror/lang-php').then((m) => m.php()),
  java: () => import('@codemirror/lang-java').then((m) => m.java()),
  c: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  h: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  cpp: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  cc: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  hpp: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),

  sh: legacy(() => import('@codemirror/legacy-modes/mode/shell').then((m) => m.shell)),
  bash: legacy(() => import('@codemirror/legacy-modes/mode/shell').then((m) => m.shell)),
  zsh: legacy(() => import('@codemirror/legacy-modes/mode/shell').then((m) => m.shell)),
  fish: legacy(() => import('@codemirror/legacy-modes/mode/shell').then((m) => m.shell)),
  toml: legacy(() => import('@codemirror/legacy-modes/mode/toml').then((m) => m.toml)),
  ini: legacy(() => import('@codemirror/legacy-modes/mode/properties').then((m) => m.properties)),
  conf: legacy(() => import('@codemirror/legacy-modes/mode/properties').then((m) => m.properties)),
  env: legacy(() => import('@codemirror/legacy-modes/mode/properties').then((m) => m.properties)),
  properties: legacy(() =>
    import('@codemirror/legacy-modes/mode/properties').then((m) => m.properties),
  ),
  dockerfile: legacy(() =>
    import('@codemirror/legacy-modes/mode/dockerfile').then((m) => m.dockerFile),
  ),
  rb: legacy(() => import('@codemirror/legacy-modes/mode/ruby').then((m) => m.ruby)),
  lua: legacy(() => import('@codemirror/legacy-modes/mode/lua').then((m) => m.lua)),
  pl: legacy(() => import('@codemirror/legacy-modes/mode/perl').then((m) => m.perl)),
  swift: legacy(() => import('@codemirror/legacy-modes/mode/swift').then((m) => m.swift)),
  kt: legacy(() => import('@codemirror/legacy-modes/mode/clike').then((m) => m.kotlin)),
  scala: legacy(() => import('@codemirror/legacy-modes/mode/clike').then((m) => m.scala)),
  cs: legacy(() => import('@codemirror/legacy-modes/mode/clike').then((m) => m.csharp)),
  diff: legacy(() => import('@codemirror/legacy-modes/mode/diff').then((m) => m.diff)),
  patch: legacy(() => import('@codemirror/legacy-modes/mode/diff').then((m) => m.diff)),
  nginx: legacy(() => import('@codemirror/legacy-modes/mode/nginx').then((m) => m.nginx)),
  ps1: legacy(() => import('@codemirror/legacy-modes/mode/powershell').then((m) => m.powerShell)),
  r: legacy(() => import('@codemirror/legacy-modes/mode/r').then((m) => m.r)),
  hs: legacy(() => import('@codemirror/legacy-modes/mode/haskell').then((m) => m.haskell)),
  cmake: legacy(() => import('@codemirror/legacy-modes/mode/cmake').then((m) => m.cmake)),
  proto: legacy(() => import('@codemirror/legacy-modes/mode/protobuf').then((m) => m.protobuf)),
}

/**
 * Whole-name matching for extensionless files. Node treats .env as a name, not an extension,
 * previously leaving it uncolored including comments. Prefixes cover variants such as .env.local
 * and Dockerfile.dev.
 */
const NAMED: { prefix: string; extension: string }[] = [
  { prefix: '.env', extension: 'env' },
  { prefix: 'dockerfile', extension: 'dockerfile' },
  { prefix: 'cmakelists.txt', extension: 'cmake' },
  { prefix: '.gitignore', extension: 'ini' },
  { prefix: '.dockerignore', extension: 'ini' },
  { prefix: '.editorconfig', extension: 'ini' },
  { prefix: '.npmrc', extension: 'ini' },
  { prefix: '.bashrc', extension: 'sh' },
  { prefix: '.bash_profile', extension: 'sh' },
  { prefix: '.zshrc', extension: 'sh' },
  { prefix: '.zshenv', extension: 'sh' },
  { prefix: '.zprofile', extension: 'sh' },
  { prefix: '.profile', extension: 'sh' },
  { prefix: 'tsconfig', extension: 'jsonc' },
  { prefix: 'jsconfig', extension: 'jsonc' },
]

/**
 * Mode from file path. Whole names precede extensions because .env.local has the meaningless
 * extension local under Node rules.
 */
export function extensionOfPath(path: string): string {
  const name = (path.split('/').pop() ?? '').toLowerCase()
  const named = NAMED.find((entry) => name === entry.prefix || name.startsWith(entry.prefix + '.'))
  if (named) return named.extension

  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1)
}

export async function loadLanguage(path: string): Promise<LanguageSupport | null> {
  const loader = LOADERS[extensionOfPath(path)]
  return loader ? loader() : null
}

/**
 * Line break a text mostly uses. CodeMirror splits lines on any break but joins them with `\n`,
 * so without this a CRLF file came back entirely rewritten in LF on the first save. A file mixing
 * breaks keeps its majority one.
 */
export function lineBreakOf(text: string): '\n' | '\r\n' | '\r' {
  let crlf = 0
  let lf = 0
  let cr = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code === 10) lf += 1
    else if (code === 13) {
      if (text.charCodeAt(index + 1) === 10) {
        crlf += 1
        index += 1
      } else cr += 1
    }
  }
  if (crlf > lf && crlf >= cr) return '\r\n'
  if (cr > lf && cr > crlf) return '\r'
  return '\n'
}

/**
 * Marks text replaced from outside, after a reread: the editor must not report it as typing,
 * which would pin a preview tab and rewrite the draft.
 */
export const externalChange = Annotation.define<boolean>()

/** Lines touched by a reread, or null to clear them. */
export const flashLines = StateEffect.define<{ from: number; to: number } | null>()

/** Beyond this, a reread replaced the whole file: flashing all of it would show nothing more. */
const MAX_FLASHED_LINES = 400
const flashedLine = Decoration.line({ class: 'cm-externalChange' })

/**
 * Briefly highlights lines an agent just changed in the open file. Without it, text shifted
 * under the reader's eyes with no hint of where.
 */
export const flashedChanges = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(lines, transaction) {
    let next = lines.map(transaction.changes)
    for (const effect of transaction.effects) {
      if (!effect.is(flashLines)) continue
      if (!effect.value) {
        next = Decoration.none
        continue
      }
      const { doc } = transaction.state
      const first = doc.lineAt(effect.value.from).number
      const last = doc.lineAt(Math.max(effect.value.from, effect.value.to - 1)).number
      if (last - first > MAX_FLASHED_LINES) continue
      const builder = new RangeSetBuilder<Decoration>()
      for (let number = first; number <= last; number += 1) {
        const line = doc.line(number)
        builder.add(line.from, line.from, flashedLine)
      }
      next = builder.finish()
    }
    return next
  },
  provide: (field) => EditorView.decorations.from(field),
})

/**
 * Single change turning `before` into `after`: common start and end kept, so the cursor, the
 * scroll position and undo history around them survive a reread.
 */
export function smallestChange(before: string, after: string): { from: number; to: number; insert: string } {
  const shortest = Math.min(before.length, after.length)
  let start = 0
  while (start < shortest && before.charCodeAt(start) === after.charCodeAt(start)) start += 1
  let end = 0
  while (
    end < shortest - start &&
    before.charCodeAt(before.length - 1 - end) === after.charCodeAt(after.length - 1 - end)
  ) end += 1
  return { from: start, to: before.length - end, insert: after.slice(start, after.length - end) }
}

/** Files whose format requires tabs, empty ones included: Go (gofmt) and make recipes. */
function tabsRequired(path: string): boolean {
  const name = (path.split('/').pop() ?? '').toLowerCase()
  return name.endsWith('.go') || name.endsWith('.mk') || name === 'makefile' || name === 'gnumakefile'
}

/** Beyond this, the file's start has said enough about its style. */
const INDENT_SAMPLE_LINES = 2_000

/**
 * Indentation a file already uses, inserted by Tab and new lines: two spaces everywhere broke Go
 * files (gofmt wants tabs), Makefiles (recipes require them) and four-space Python. Tabs when more
 * lines start with one; otherwise the most frequent step between consecutive indented lines.
 */
export function indentationOf(text: string, path: string): string {
  let tabs = 0
  let spaces = 0
  let previous = 0
  const steps = new Map<number, number>()
  const lines = text.split(/\r\n?|\n/, INDENT_SAMPLE_LINES)
  for (const line of lines) {
    const indent = /^[ \t]*/.exec(line)?.[0] ?? ''
    if (indent.length === line.length) continue
    if (indent.startsWith('\t')) {
      tabs += 1
      continue
    }
    if (indent.length > 0) spaces += 1
    // Steps of one are block-comment stars (` * `), not indentation.
    const step = Math.abs(indent.length - previous)
    if (step >= 2 && step <= 8) steps.set(step, (steps.get(step) ?? 0) + 1)
    previous = indent.length
  }
  if (tabs > spaces || (tabs === 0 && spaces === 0 && tabsRequired(path))) return '\t'
  let width = 2
  let best = 0
  for (const [step, count] of steps) {
    if (count > best) {
      width = step
      best = count
    }
  }
  return ' '.repeat(width)
}
