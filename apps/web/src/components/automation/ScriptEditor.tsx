import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { useEffect, useRef } from 'react'
import { cx } from '../ui'
import { editorHighlight, editorTheme, loadLanguage } from '../panel/editor-setup'

/**
 * Un petit éditeur de code pour la page d'une automatisation (script, corps d'un appel
 * d'essai) : CodeMirror avec le thème de l'éditeur du panneau. Volontairement plus simple
 * que `CodeEditor`, fait pour des fichiers et leurs sessions : ici un seul texte, tenu
 * par la page.
 */
export function ScriptEditor({
  value,
  onChange,
  label,
  language = 'automation.js',
  maxHeight = '24rem',
  className,
}: {
  value: string
  onChange: (value: string) => void
  label: string
  /** Nom de fichier dont l'extension choisit la coloration : `automation.js`, `payload.json`. */
  language?: string
  /**
   * Hauteur au-delà de laquelle l'éditeur défile en lui-même. Posée sur l'éditeur et non
   * sur son conteneur : CodeMirror ne défile que si c'est lui qui est borné.
   */
  maxHeight?: string
  className?: string
}) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const latest = useRef(onChange)
  latest.current = onChange

  useEffect(() => {
    if (!host.current) return
    // La grammaire se charge à part : l'éditeur s'ouvre tout de suite, en clair, puis se colore.
    const grammar = new Compartment()
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          editorTheme,
          editorHighlight,
          EditorView.theme({ '&': { maxHeight }, '.cm-scroller': { overflow: 'auto' } }),
          grammar.of([]),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'aria-label': label }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) latest.current(update.state.doc.toString())
          }),
        ],
      }),
    })
    view.current = editor
    let cancelled = false
    void loadLanguage(language).then((support) => {
      if (!cancelled && support) editor.dispatch({ effects: grammar.reconfigure(support) })
    })
    return () => {
      cancelled = true
      editor.destroy()
      view.current = null
    }
    // Monté une fois : la valeur suivante vient de l'éditeur lui-même, la repousser à
    // chaque frappe ferait sauter le curseur.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Une valeur changée de l'extérieur (réglages annulés, modèle chargé) remplace le texte.
  useEffect(() => {
    const editor = view.current
    if (!editor || editor.state.doc.toString() === value) return
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } })
  }, [value])

  return <div ref={host} className={cx('min-h-40 overflow-hidden rounded-md border border-line bg-sunken text-[0.8125rem]', className)} />
}
