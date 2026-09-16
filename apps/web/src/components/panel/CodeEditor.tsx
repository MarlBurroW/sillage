import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { Compartment, EditorState, StateEffect } from '@codemirror/state'
import { gotoLine, openSearchPanel, search, searchKeymap } from '@codemirror/search'
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view'
import {
  bracketMatching,
  foldGutter,
  indentOnInput,
  indentUnit,
} from '@codemirror/language'
import { useImperativeHandle, useLayoutEffect, useRef, type Ref } from 'react'
import { translate } from '../../lib/i18n'
import { editorHighlight, editorTheme, loadLanguage } from './editor-setup'

export interface CodeEditorHandle {
  find: () => void
  goToLine: () => void
}

// En mémoire seulement, par compte/workspace/fichier. Un seul DOM CodeMirror reste
// monté, mais revenir au document retrouve sa sélection, son défilement et Annuler.
const sessions = new Map<string, { state: EditorState; scroll: ReturnType<EditorView['scrollSnapshot']>; revision: number }>()
const MAX_SESSIONS = 40

/**
 * Intitulés du panneau de recherche.
 *
 * CodeMirror expose ses libellés par la facette `phrases` : les traduire ici évite
 * d'avoir à réécrire le panneau, et c'est le mécanisme prévu pour ça.
 */
function searchPhrases(): Record<string, string> {
  return {
    Find: translate('editor.search.find'),
    Replace: translate('editor.search.replace'),
    next: translate('editor.search.next'),
    previous: translate('editor.search.previous'),
    all: translate('editor.search.all'),
    'match case': translate('editor.search.matchCase'),
    'by word': translate('editor.search.byWord'),
    regexp: translate('editor.search.regexp'),
    replace: translate('editor.search.replaceAction'),
    'replace all': translate('editor.search.replaceAll'),
    close: translate('editor.search.close'),
    'current match': translate('editor.search.currentMatch'),
    'replaced $ matches': translate('editor.search.replacedMatches'),
    'replaced match on line $': translate('editor.search.replacedMatchOnLine'),
    'on line': translate('editor.search.onLine'),
    'Go to line': translate('editor.goToLine'),
    go: translate('editor.go'),
  }
}

/**
 * Éditeur de texte d'un onglet.
 *
 * CodeMirror plutôt que Monaco : le second pèse vingt fois plus et n'apporte ici que
 * ce dont on se prive volontairement (LSP, autocomplétion). Le nécessaire est monté
 * explicitement plutôt que par `basicSetup` : ce dernier embarque l'autocomplétion et
 * le linting, qui n'ont rien à faire dans un éditeur sans serveur de langage.
 */
export function CodeEditor({
  /** Contenu de départ, lu au montage seulement. */
  initial,
  path,
  onChange,
  onSave,
  sessionKey,
  revision,
  onPosition,
  ref,
}: {
  initial: string
  path: string
  onChange: (value: string) => void
  onSave: () => void
  sessionKey: string
  revision: number
  onPosition: (line: number, column: number) => void
  ref?: Ref<CodeEditorHandle>
}) {
  const host = useRef<HTMLDivElement>(null)
  const current = useRef<EditorView | null>(null)
  useImperativeHandle(ref, () => ({
    find: () => { if (current.current) openSearchPanel(current.current) },
    goToLine: () => { if (current.current) gotoLine(current.current) },
  }), [])
  /**
   * Les rappels sont lus au moment de l'événement, jamais capturés dans les extensions :
   * les recréer reconstruirait l'état de l'éditeur et perdrait le curseur à chaque frappe.
   */
  const handlers = useRef({ onChange, onSave, onPosition })
  handlers.current = { onChange, onSave, onPosition }
  /**
   * Le contenu ne se pousse pas dans un éditeur vivant : le reconstruire pour suivre la
   * prop effacerait le curseur et l'historique de qui est en train de taper. Il n'est lu
   * qu'au montage, ce qui laisse l'appelant décider par quoi repartir en le remontant.
   */
  const content = useRef(initial)
  content.current = initial

  // Capturer le défilement avant que React ne détache le DOM du fichier précédent.
  useLayoutEffect(() => {
    const parent = host.current
    if (!parent) return

    const language = new Compartment()

    const position = (state: EditorState) => {
      const head = state.selection.main.head
      const line = state.doc.lineAt(head)
      handlers.current.onPosition(line.number, head - line.from + 1)
    }
    const extensions = [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        foldGutter(),
        drawSelection(),
        history(),
        indentOnInput(),
        bracketMatching(),
        indentUnit.of('  '),
        language.of([]),
        // En haut : en bas, le panneau se retrouve sous la barre d'état du fichier,
        // et sur un panneau étroit il occupe alors la moitié de la hauteur visible.
        search({ top: true }),
        EditorState.phrases.of(searchPhrases()),
        editorTheme,
        editorHighlight,
        EditorView.lineWrapping,
        keymap.of([
          {
            // Le raccourci d'enregistrement du navigateur sauvegarderait la page.
            key: 'Mod-s',
            preventDefault: true,
            run: () => {
              handlers.current.onSave()
              return true
            },
          },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) handlers.current.onChange(update.state.doc.toString())
          if (update.docChanged || update.selectionSet) position(update.state)
        }),
      ]
    const cached = sessions.get(sessionKey)
    const reusable = cached?.revision === revision && cached.state.doc.toString() === content.current
    // Rebrancher les callbacks sur le composant actuel sans vider historyField.
    const state = reusable
      ? cached.state.update({ effects: StateEffect.reconfigure.of(extensions) }).state
      : EditorState.create({ doc: content.current, extensions })

    const editor = new EditorView({ state, parent, scrollTo: reusable ? cached.scroll : undefined })
    current.current = editor
    position(state)

    // Le mode arrive après coup : l'attendre laisserait un éditeur vide le temps du
    // chargement, alors que le texte est déjà là.
    let cancelled = false
    void loadLanguage(path).then((support) => {
      if (cancelled || !support) return
      editor.dispatch({ effects: language.reconfigure(support) })
    })

    return () => {
      cancelled = true
      sessions.delete(sessionKey)
      sessions.set(sessionKey, { state: editor.state, scroll: editor.scrollSnapshot(), revision })
      if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value!)
      current.current = null
      editor.destroy()
    }
  }, [path, sessionKey, revision])

  return <div ref={host} className="h-full overflow-hidden" />
}
