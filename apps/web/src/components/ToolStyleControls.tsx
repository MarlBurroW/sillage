import { useTranslate } from '../lib/i18n'
import { TOOL_STYLES, TOOL_STYLE_LABELS, useToolStyle } from '../lib/tool-style'
import type { ToolItem } from '../lib/chat-fold'
import { ToolCallGroup } from './chat/ToolCall'
import { cx } from './ui'

// L’aperçu emploie les vrais composants, sans conversation ni accès à une sortie distante.
const preview: ToolItem[] = [
  { kind: 'tool', id: 'preview-sillage', name: 'sillage/read_memory', ts: 0, input: { file: 'project.md' }, output: 'project.md', outputBytes: null, status: 'done', durationMs: 120, parentToolCallId: null },
  { kind: 'tool', id: 'preview-mcp', name: 'github/issue_read', ts: 0, input: { query: '#58' }, output: '#58', outputBytes: null, status: 'done', durationMs: 350, parentToolCallId: null },
  { kind: 'tool', id: 'preview-native', name: 'Read', ts: 0, input: { file_path: 'src/App.tsx' }, output: 'export function App() { … }', outputBytes: null, status: 'running', durationMs: null, parentToolCallId: null },
]
export function ToolStyleControls() {
  const [style, setStyle] = useToolStyle()
  const t = useTranslate()
  return <div className="flex flex-col gap-4">
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" role="group" aria-label={t('toolStyle.title')}>
      {TOOL_STYLES.map((option) => <button key={option} type="button" aria-pressed={style === option}
        onClick={() => setStyle(option)} className={cx('rounded-md border px-3 py-2 text-xs', style === option ? 'border-accent bg-accent-wash' : 'border-line hover:border-line-strong')}>
        {t(TOOL_STYLE_LABELS[option])}
        {option === 'inline' ? <span className="block text-[0.625rem] text-ink-faint">{t('toolStyle.default')}</span> : null}
      </button>)}
    </div>
    <div className="rounded-md border border-line bg-canvas p-3" data-tool-style-preview>
      <p className="mb-2 text-xs text-ink-faint">{t('toolStyle.preview')}</p>
      <p className="mb-3 text-sm">{t('toolStyle.sample')}</p>
      <ToolCallGroup tools={preview} complete={false} conversationId="appearance-preview" />
    </div>
  </div>
}
