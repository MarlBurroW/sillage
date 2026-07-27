import { HighlightStyle, LanguageSupport, syntaxHighlighting } from '@codemirror/language'
import { EditorView } from '@codemirror/view'
import { tags } from '@lezer/highlight'

/**
 * Habillage de CodeMirror par les jetons de Sillage.
 *
 * Un thème importé (`one-dark` et consorts) jurerait avec le reste : les couleurs
 * viennent des mêmes variables que la coloration des blocs de code du fil, donc
 * changer de thème ou de teinte déplace l'éditeur avec.
 *
 * Les valeurs sont des `var()` et non des couleurs résolues : le thème se change à
 * chaud sans reconstruire l'éditeur.
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
  // Sans `!important`, la couche de sélection de CodeMirror l'emporte sur le thème.
  '.cm-selectionBackground, ::selection': { backgroundColor: 'var(--sg-accent-wash) !important' },
  '&.cm-focused': { outline: 'none' },
  '.cm-selectionMatch': { backgroundColor: 'var(--sg-accent-wash)' },
  '.cm-searchMatch': { backgroundColor: 'var(--sg-accent-wash)' },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'var(--sg-accent)',
    color: 'var(--sg-accent-ink)',
  },
  /*
   * Panneau de recherche. CodeMirror l'habille en champs et boutons natifs, blancs
   * quel que soit le thème : il jurait avec le reste et devenait illisible en sombre.
   * Les règles ci-dessous reprennent les mêmes jetons que les contrôles de Sillage.
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
    // Le dégradé natif de CodeMirror ignore la couleur de fond qu'on lui donne.
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

/** Mêmes sept familles que la coloration du fil : une seule palette pour l'application. */
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
 * Modes chargés à la demande, comme highlight.js pour le fil : embarquer tous les
 * langages ferait grossir le paquet initial pour un panneau qu'on n'ouvre pas toujours.
 *
 * Les extensions sont les clés, ce que le serveur renvoie déjà. Une extension absente
 * ne colore rien plutôt que d'appliquer un mode approximatif.
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
}

export async function loadLanguage(extension: string): Promise<LanguageSupport | null> {
  const loader = LOADERS[extension]
  return loader ? loader() : null
}
