import {
  HighlightStyle,
  LanguageSupport,
  syntaxHighlighting,
  type StreamParser,
} from '@codemirror/language'
import { EditorView } from '@codemirror/view'
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
  tsx: () =>
    import('@codemirror/lang-javascript').then((m) => m.javascript({ typescript: true, jsx: true })),
  js: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  mjs: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  cjs: () => import('@codemirror/lang-javascript').then((m) => m.javascript()),
  jsx: () => import('@codemirror/lang-javascript').then((m) => m.javascript({ jsx: true })),
  json: () => import('@codemirror/lang-json').then((m) => m.json()),
  md: () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
  markdown: () => import('@codemirror/lang-markdown').then((m) => m.markdown()),
  css: () => import('@codemirror/lang-css').then((m) => m.css()),
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
  { prefix: '.zshrc', extension: 'sh' },
  { prefix: '.profile', extension: 'sh' },
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
