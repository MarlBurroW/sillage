import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { Compartment, EditorState, StateEffect, Text, Transaction, type TransactionSpec } from '@codemirror/state'
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
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, type Ref } from 'react'
import { translate } from '../../lib/i18n'
import {
  editorHighlight,
  editorTheme,
  externalChange,
  flashLines,
  flashedChanges,
  lineBreakOf,
  loadLanguage,
  smallestChange,
} from './editor-setup'

export interface CodeEditorHandle {
  find: () => void
  goToLine: () => void
}

// Memory-only state per account/workspace/file. Keep only one CodeMirror DOM mounted, restoring
// selection, scroll, and undo when returning to documents.
const sessions = new Map<string, { state: EditorState; scroll: ReturnType<EditorView['scrollSnapshot']> }>()
const MAX_SESSIONS = 40

/** How long lines changed by a reread stay highlighted; matches the CSS animation. */
const FLASH_MS = 1600

/**
 * The smallest change bringing `state` to `next`, outside undo history, not reported as typing,
 * with its lines flashed; null when nothing differs. Rebuilding the state instead sent the reader
 * back to the top of the file at every agent write.
 */
function externalUpdate(state: EditorState, next: string): (TransactionSpec & { effects: StateEffect<unknown>[] }) | null {
  // CodeMirror splits on any line break and joins with \n.
  const target = next.replace(/\r\n?/g, '\n')
  const before = state.doc.toString()
  if (before === target) return null
  const change = smallestChange(before, target)
  return {
    changes: change,
    annotations: [externalChange.of(true), Transaction.addToHistory.of(false)],
    effects: [flashLines.of({ from: change.from, to: change.from + change.insert.length })],
  }
}

function clearFlashLater(editor: EditorView): void {
  setTimeout(() => {
    // Destroyed views keep their state but no longer belong to the page.
    if (editor.dom.isConnected) editor.dispatch({ effects: flashLines.of(null) })
  }, FLASH_MS)
}

function syncText(editor: EditorView, next: string): void {
  const update = externalUpdate(editor.state, next)
  if (!update) return
  editor.dispatch(update)
  clearFlashLater(editor)
}

/** Chunk buttons of the comparison, labeled for its meaning here: the other side is the disk. */
function chunkButton(type: 'accept' | 'reject', action: (event: MouseEvent) => void): HTMLElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.name = type
  button.textContent = translate(type === 'accept' ? 'editor.compare.keep' : 'editor.compare.restore')
  button.title = translate(type === 'accept' ? 'editor.compare.keep.title' : 'editor.compare.restore.title')
  // Like the package's own buttons: on mousedown, before the editor takes focus and moves the cursor.
  button.onmousedown = action
  return button
}

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
  lineBreak,
  original = null,
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
  /**
   * Line break written back in `onChange`, the file's own. Defaults to the one `initial` mostly
   * uses; callers holding the version on disk pass it so a draft that lost every line break still
   * saves with the file's.
   */
  lineBreak?: string
  /**
   * Text to compare with, usually the version on disk: changes show inline with buttons to keep
   * or restore each chunk. Null hides the comparison.
   */
  original?: string | null
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
   * Typing never comes back through `initial`: following it on each render would fight the
   * cursor. A text replaced elsewhere is signaled by `revision` and applied in place.
   */
  const content = useRef(initial)
  content.current = initial
  const comparedWith = useRef(original)
  comparedWith.current = original
  const merge = useRef<Compartment | null>(null)

  /** The comparison module loads on first use: most sessions never compare anything. */
  const showComparison = (editor: EditorView, compartment: Compartment, text: string | null) => {
    if (text === null) {
      // Nothing to remove: an empty transaction here would cancel the scroll position restored on mount.
      const shown = compartment.get(editor.state)
      if (!Array.isArray(shown) || shown.length > 0) editor.dispatch({ effects: compartment.reconfigure([]) })
      return
    }
    void import('@codemirror/merge').then(({ unifiedMergeView }) => {
      // The comparison may have been closed or changed while the module loaded.
      if (current.current !== editor || comparedWith.current !== text) return
      editor.dispatch({
        effects: compartment.reconfigure(
          unifiedMergeView({ original: Text.of(text.split(/\r\n?|\n/)), mergeControls: chunkButton }),
        ),
      })
    })
  }

  // Capture scroll before React detaches the previous file's DOM.
  useLayoutEffect(() => {
    const parent = host.current
    if (!parent) return

    const language = new Compartment()
    const comparison = new Compartment()
    const separator = lineBreak ?? lineBreakOf(content.current)
    const text = (state: EditorState) => state.doc.sliceString(0, state.doc.length, separator)

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
        comparison.of([]),
        flashedChanges,
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
          const typed = update.transactions.some((transaction) => transaction.docChanged && !transaction.annotation(externalChange))
          if (typed) handlers.current.onChange(text(update.state))
          if (update.docChanged || update.selectionSet) position(update.state)
        }),
      ]
    const cached = sessions.get(sessionKey)
    let state: EditorState
    let scrollTo: ReturnType<EditorView['scrollSnapshot']> | undefined
    let flashed = false
    if (!cached) state = EditorState.create({ doc: content.current, extensions })
    else {
      // Reconnect callbacks to the current component without clearing historyField. Text reread
      // while this file was not displayed, typically an agent's write, is applied in the same
      // step, before the view exists: a transaction after mounting would cancel the scroll
      // position restored here.
      const update = externalUpdate(cached.state, content.current)
      const transaction = cached.state.update({
        ...update,
        effects: [StateEffect.reconfigure.of(extensions), ...(update?.effects ?? [])],
      })
      state = transaction.state
      scrollTo = cached.scroll.map(transaction.changes)
      flashed = update !== null
    }

    const editor = new EditorView({ state, parent, scrollTo })
    current.current = editor
    // The restored position applies at the view's first measure. Unmounted before that (React's
    // strict mode remounts at once; a prop may change right after opening), a new snapshot would
    // record the top of the file and lose the position for good: keep the one being restored.
    let measured = false
    const frame = requestAnimationFrame(() => requestAnimationFrame(() => { measured = true }))
    merge.current = comparison
    if (flashed) clearFlashLater(editor)
    position(editor.state)
    if (comparedWith.current !== null) showComparison(editor, comparison, comparedWith.current)

    // Language mode loads afterward: waiting would leave an empty editor despite available text.
    let cancelled = false
    void loadLanguage(path).then((support) => {
      if (cancelled || !support) return
      editor.dispatch({ effects: language.reconfigure(support) })
    })

    return () => {
      cancelled = true
      cancelAnimationFrame(frame)
      sessions.delete(sessionKey)
      sessions.set(sessionKey, {
        state: editor.state,
        scroll: !measured && scrollTo ? scrollTo : editor.scrollSnapshot(),
      })
      if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value!)
      current.current = null
      merge.current = null
      editor.destroy()
    }
  }, [path, sessionKey, readOnly, lineBreak])

  useEffect(() => {
    if (current.current) syncText(current.current, content.current)
  }, [revision])

  useEffect(() => {
    if (current.current && merge.current) showComparison(current.current, merge.current, original)
  }, [original])

  return <div ref={host} className="h-full overflow-hidden" />
}
