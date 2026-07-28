import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { Compartment, EditorState } from '@codemirror/state'
import { search, searchKeymap } from '@codemirror/search'
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
import { useEffect, useRef } from 'react'
import { translate } from '../../lib/i18n'
import { editorHighlight, editorTheme, loadLanguage } from './editor-setup'

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
  /** Contenu initial. Un changement de fichier remonte l'éditeur par sa clé. */
  initial,
  path,
  onChange,
  onSave,
}: {
  initial: string
  path: string
  onChange: (value: string) => void
  onSave: () => void
}) {
  const host = useRef<HTMLDivElement>(null)
  /**
   * Les rappels sont lus au moment de l'événement, jamais capturés dans les extensions :
   * les recréer reconstruirait l'état de l'éditeur et perdrait le curseur à chaque frappe.
   */
  const handlers = useRef({ onChange, onSave })
  handlers.current = { onChange, onSave }

  useEffect(() => {
    const parent = host.current
    if (!parent) return

    const language = new Compartment()

    const state = EditorState.create({
      doc: initial,
      extensions: [
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
        }),
      ],
    })

    const editor = new EditorView({ state, parent })

    // Le mode arrive après coup : l'attendre laisserait un éditeur vide le temps du
    // chargement, alors que le texte est déjà là.
    let cancelled = false
    void loadLanguage(path).then((support) => {
      if (cancelled || !support) return
      editor.dispatch({ effects: language.reconfigure(support) })
    })

    return () => {
      cancelled = true
      editor.destroy()
    }
  }, [initial, path])

  return <div ref={host} className="h-full overflow-hidden" />
}
