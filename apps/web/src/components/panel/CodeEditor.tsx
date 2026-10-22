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

// Memory-only state per account/workspace/file. Keep only one CodeMirror DOM mounted, restoring
// selection, scroll, and undo when returning to documents.
const sessions = new Map<string, { state: EditorState; scroll: ReturnType<EditorView['scrollSnapshot']>; revision: number }>()
const MAX_SESSIONS = 40

/**
 * Search-panel labels through CodeMirror's phrases facet, its intended translation mechanism,
 * without rebuilding the panel.
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
 * Tab text editor. CodeMirror instead of Monaco, twenty times larger for intentionally omitted
 * features (LSP, completion). Mount necessary extensions explicitly instead of basicSetup, which
 * bundles completion and linting inappropriate without a language server.
 */
export function CodeEditor({
  /** Initial contents read only on mount. */
  initial,
  path,
  onChange,
  onSave,
  sessionKey,
  revision,
  onPosition,
  readOnly = false,
  ref,
}: {
  initial: string
  path: string
  onChange: (value: string) => void
  onSave: () => void
  sessionKey: string
  revision: number
  onPosition: (line: number, column: number) => void
  /** Read-only users can browse and search text. */
  readOnly?: boolean
  ref?: Ref<CodeEditorHandle>
}) {
  const host = useRef<HTMLDivElement>(null)
  const current = useRef<EditorView | null>(null)
  useImperativeHandle(ref, () => ({
    find: () => { if (current.current) openSearchPanel(current.current) },
    goToLine: () => { if (current.current) gotoLine(current.current) },
  }), [])
  /**
   * Read callbacks at event time rather than capturing them in extensions: recreating extensions
   * rebuilds editor state and loses the cursor per keystroke.
   */
  const handlers = useRef({ onChange, onSave, onPosition })
  handlers.current = { onChange, onSave, onPosition }
  /**
   * Do not push contents into a live editor: following props by rebuilding would erase cursor and
   * undo history. Read on mount only so callers choose replacement through remounting.
   */
  const content = useRef(initial)
  content.current = initial

  // Capture scroll before React detaches the previous file's DOM.
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
        // Search at top: at bottom it sits below file status and consumes half the visible height in narrow panels.
        search({ top: true }),
        EditorState.phrases.of(searchPhrases()),
        editorTheme,
        editorHighlight,
        EditorView.lineWrapping,
        EditorState.readOnly.of(readOnly),
        EditorView.editable.of(!readOnly),
        keymap.of([
          {
            // Prevent the browser save shortcut from saving the page.
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
    // Reconnect callbacks to the current component without clearing historyField.
    const state = reusable
      ? cached.state.update({ effects: StateEffect.reconfigure.of(extensions) }).state
      : EditorState.create({ doc: content.current, extensions })

    const editor = new EditorView({ state, parent, scrollTo: reusable ? cached.scroll : undefined })
    current.current = editor
    position(state)

    // Language mode loads afterward: waiting would leave an empty editor despite available text.
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
  }, [path, sessionKey, revision, readOnly])

  return <div ref={host} className="h-full overflow-hidden" />
}
