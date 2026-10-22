import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap, lineNumbers } from '@codemirror/view'
import { useEffect, useRef } from 'react'
import { cx } from '../ui'
import { editorHighlight, editorTheme, loadLanguage } from '../panel/editor-setup'

/**
 * Small automation editor for scripts and trial payloads, using CodeMirror with panel-editor theme.
 * Simpler than file/session CodeEditor: one page-owned text value.
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
  /** Filename extension selecting highlighting, such as automation.js or payload.json. */
  language?: string
  /**
   * Height above which the editor itself scrolls. Set on CodeMirror rather than its wrapper because
   * only a bounded editor scrolls.
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
    // Grammar loads separately: show plain text immediately, then highlight.
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
    // Mount once: subsequent values come from editor input and pushing every keystroke back would
    // jump the cursor.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // External value changes (reset settings, loaded templates) replace text.
  useEffect(() => {
    const editor = view.current
    if (!editor || editor.state.doc.toString() === value) return
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: value } })
  }, [value])

  return <div ref={host} className={cx('min-h-40 overflow-hidden rounded-md border border-line bg-sunken text-[0.8125rem]', className)} />
}
