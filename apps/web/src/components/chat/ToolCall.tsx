import { Logo } from '../Logo'
import { toolEdits } from '../../lib/tool-edits'
import { toolWebInput } from '../../lib/tool-web-input'
import { useToolStyle, type ToolStyle } from '../../lib/tool-style'
import { toolLabel, toolOrigin, toolPreview, toolIntent, toolSummary, INTENT_LABELS } from '../../lib/tool-presentation'
import {
  Bot,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleSlash,
  CornerDownRight,
  FileText,
  FolderSearch,
  Globe,
  Image,
  ListChecks,
  ListTodo,
  Loader,
  Pencil,
  Search,
  SquareTerminal,
  Wrench,
} from 'lucide-react'
import { memo, useCallback, useLayoutEffect, useMemo, useState, type ReactNode } from 'react'
import { isSpawnTool, type ToolOutputDto } from '@sillage/protocol'
import type { ToolItem } from '../../lib/chat-fold'
import { languageFromPath } from '../../lib/highlight'
import { useTranslate } from '../../lib/i18n'
import { showSubAgent } from '../../lib/panel'
import { useEventBody, useToolOutput } from '../../lib/tool-output'
import { readableView } from '../tools/registry'
import { cx } from '../ui'
import { HighlightedCode } from './HighlightedCode'
import { ScheduleApprovalStrip } from './ScheduleApprovalStrip'
import { isSillageTool } from '../../lib/sillage-tools'

/**
 * Render tool calls and collapsed sequences. Share a module because expanded groups render calls;
 * separating them would create needless import cycles.
 */

/** Tool icons; detailed rendering uses the tools view registry. */
const TOOL_ICONS: Record<string, ReactNode> = {
  Bash: <SquareTerminal size={14} />,
  Read: <FileText size={14} />,
  ViewImage: <Image size={14} />,
  Write: <Pencil size={14} />,
  Edit: <Pencil size={14} />,
  ApplyPatch: <Pencil size={14} />,
  NotebookEdit: <Pencil size={14} />,
  LS: <FolderSearch size={14} />,
  Glob: <FolderSearch size={14} />,
  Grep: <Search size={14} />,
  WebFetch: <Globe size={14} />,
  WebSearch: <Globe size={14} />,
  TodoWrite: <ListTodo size={14} />,
  Task: <Bot size={14} />,
  Agent: <Bot size={14} />,
  ExitPlanMode: <ListChecks size={14} />,
}

/**
 * Call outcome icon. Interrupted is not failure: the CLI stopped before returning. Treating it as
 * an error would prompt investigation of a nonexistent cause.
 */
export function ToolStatusIcon({ status }: { status: ToolItem['status'] }) {
  if (status === 'running') return <Loader size={13} className="shrink-0 animate-spin text-accent" />
  if (status === 'failed') return <CircleAlert size={13} className="shrink-0 text-critical" />
  if (status === 'interrupted') return <CircleSlash size={13} className="shrink-0 text-ink-faint" />
  return <CircleCheck size={13} className="shrink-0 text-positive" />
}

/**
 * Duration at suitable precision. Name minutes instead of accumulating seconds: multi-minute
 * subagents are common and 185.0 s requires repeated mental conversion.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`

  const seconds = Math.round(ms / 1000)
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`
}

/** File language declared by the call, when available. */
function languageOfInput(input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  const fields = input as Record<string, unknown>
  const path = fields.file_path ?? fields.path
  return typeof path === 'string' ? languageFromPath(path) : ''
}

/**
 * Tool payload and applicable language. Outputs may be JSON or plain file/command text;
 * JSON-highlighting command output harms readability. Fallback applies only to strings whose source
 * file is declared.
 */
function asPayload(value: unknown, fallback = ''): { content: string; language: string } {
  if (value === null || value === undefined) return { content: '', language: '' }
  if (typeof value === 'string') return { content: value, language: fallback }
  return { content: JSON.stringify(value, null, 2), language: 'json' }
}

/**
 * Output to display: log output or loaded full body. Undefined until the query returns, distinct
 * from genuinely empty output in OutputSlot.
 */
function outputOf(tool: ToolItem, full: ToolOutputDto | undefined): unknown {
  if (tool.outputBytes === null) return tool.output
  return full ? full.output : undefined
}

/** Output, loading state, or loading failure. */
function OutputSlot({
  ready,
  error,
  output,
  language,
}: {
  ready: boolean
  error: Error | null
  output: unknown
  language?: string
}) {
  const t = useTranslate()

  if (error) {
    return (
      <p className="text-[0.6875rem] text-critical">{error.message || t('toolcall.output.error')}</p>
    )
  }

  if (!ready) {
    return (
      <p className="flex items-center gap-1.5 text-[0.6875rem] text-ink-faint">
        <Loader size={11} className="animate-spin" />
        {t('toolcall.output.loading')}
      </p>
    )
  }

  return <Payload label={t('toolcall.payload.output')} {...asPayload(output, language)} />
}

export const ToolCall = memo(function ToolCall({
  tool,
  conversationId,
  variant,
  onOpenChange,
}: {
  tool: ToolItem
  conversationId: string
  variant?: ToolStyle
  onOpenChange?: (id: string, open: boolean) => void
}) {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const [raw, setRaw] = useState(false)
  const edits = useMemo(() => toolEdits(tool), [tool])
  const summary = toolSummary(tool, edits)
  const counts = tool.status === 'failed' || tool.status === 'interrupted' ? null : edits?.counts
  const countLabel = counts ? t(edits?.scope === 'written'
    ? tool.status === 'running' ? 'tool.write.countsPlanned' : 'tool.write.counts'
    : tool.status === 'running' ? 'tool.edit.countsPlanned' : edits?.scope === 'replacement' ? 'tool.edit.countsReplacement' : edits?.scope === 'fragment' ? 'tool.edit.countsFragment' : 'tool.edit.counts', counts) : ''
  const [preferredStyle] = useToolStyle()
  const style = variant ?? preferredStyle
  const origin = toolOrigin(tool.name, tool.presentation)
  const label = toolLabel(tool.name, tool.presentation)
  const statusLabel = t(tool.status === 'running' ? 'toolStyle.pending' : tool.status === 'done' ? 'toolStyle.done' : tool.status === 'failed' ? 'toolStyle.failed' : 'toolStyle.stopped')


  return (
    <div
      className={cx(
        `sg-tool sg-tools-${style} sg-tool-${origin.kind} sg-tool-${tool.status} text-sm`,
        'border-line',
      )}
      data-tool-id={tool.id}
      data-thread-anchor={`tool-${tool.id}`}
    >
      <button
        type="button"
        title={`${label} — ${statusLabel}${summary ? ` — ${summary.text}` : ''}`}
        onClick={() => { setOpen(!open); onOpenChange?.(tool.id, !open) }}
        aria-expanded={open}
        className="sg-tool-heading flex w-full items-center gap-2 text-left"
      >
        <ChevronRight
          size={14}
          className={cx('shrink-0 text-ink-faint transition-transform', open && 'rotate-90')}
        />
        {origin.kind === 'sillage' ? <Logo size={16} className="shrink-0 text-accent" /> : origin.kind === 'mcp' ? <span className="sg-mcp-mark">MCP</span> : <span className="sg-native-icon shrink-0 text-ink-faint">{TOOL_ICONS[tool.name] ?? <Wrench size={14} />}</span>}
        <span className="sg-tool-label min-w-0 truncate font-medium">{label}</span>
        {origin.kind === 'mcp' ? <span className="sg-tool-server" title={origin.server}>{origin.server}</span> : null}
        {summary ? (
          <span
            className={cx('min-w-0 flex-1 truncate text-xs text-ink-faint', summary.mono && 'font-mono')}
            title={summary.text}
          >
            {summary.text}
          </span>
        ) : (
          <span className="flex-1" />
        )}

        {counts ? <span className="sg-tool-counts" role="img" aria-label={countLabel} title={countLabel}>
          <span className="text-positive">+{counts.added}</span>
          {edits?.scope !== 'written' ? <span className="text-critical">−{counts.removed}</span> : null}
        </span> : null}
        <span className={cx('shrink-0', tool.status === 'failed' && 'sg-tool-failure')} role="img" aria-label={statusLabel}>
          <ToolStatusIcon status={tool.status} />
          {tool.status === 'failed' ? <span>{statusLabel}</span> : null}
        </span>
        {tool.durationMs !== null ? (
          <span className="shrink-0 text-[0.6875rem] text-ink-faint">
            {formatDuration(tool.durationMs)}
          </span>
        ) : null}
      </button>

      {style === 'cards' && !open ? <div className="sg-tool-preview" title={toolPreview(tool)}>{toolPreview(tool)}</div> : null}
      {open ? (
        <ToolDetail tool={tool} conversationId={conversationId} raw={raw} setRaw={setRaw} />
      ) : null}

      {/* Subagent threads live in the panel: this shortcut avoids finding them manually in a list. */}
      {isSpawnTool(tool.name) ? (
        <button
          type="button"
          onClick={() => showSubAgent(tool.id)}
          className={cx(
            'flex w-full items-center gap-1.5 border-t border-line px-2.5 py-1.5',
            'text-left text-[0.6875rem] text-ink-faint hover:text-accent',
          )}
        >
          <CornerDownRight size={11} className="shrink-0" />
          {t('toolcall.subagent.view')}
        </button>
      ) : null}

      {tool.status === 'done' && isSillageTool(tool.name, 'schedule_task') ? <ScheduleApprovalStrip tool={tool} /> : null}
    </div>
  )
})

/** Mount only while expanded, so closing releases large query data and aborts pending requests. */
function ToolDetail({ tool, conversationId, raw, setRaw }: {
  tool: ToolItem; conversationId: string; raw: boolean; setRaw: (raw: boolean) => void
}) {
  const t = useTranslate()
  const inputBody = useEventBody(conversationId, tool.inputRef)
  const outputBody = useEventBody(conversationId, tool.outputRef)
  const legacy = useToolOutput(conversationId, tool.id, tool.outputBytes !== null && !tool.outputRef)
  const inputReady = !tool.inputRef || inputBody.data !== undefined
  const outputReady = tool.outputRef ? outputBody.data !== undefined : tool.outputBytes === null || legacy.data !== undefined
  const storedInput = tool.inputRef ? inputBody.data?.value : tool.input
  const output = tool.outputRef ? outputBody.data?.value : outputOf(tool, legacy.data)
  const input = toolWebInput({ ...tool, input: storedInput, output })
  const ready = inputReady && outputReady
  const readable = ready ? readableView({ ...tool, input, output }) : null
  return <div className="sg-tool-detail flex flex-col gap-2 border-t border-line px-2.5 py-2">
    <span className="break-all text-xs text-ink-faint">{t('toolStyle.rawName', { name: tool.name })}</span>
    {inputBody.error ? <p className="text-xs text-critical" role="alert">{inputBody.error.message || t('journal.content.error')}</p> : null}
    {!inputReady && !inputBody.error ? <p className="text-xs text-ink-faint">{t('journal.content.loading')}</p> : null}
    {readable ? <ViewSwitch raw={raw} onChange={setRaw} /> : null}
    {readable && !raw ? readable : <>
      {inputReady ? <Payload label={t('toolcall.payload.input')} {...asPayload(input)} /> : null}
      {tool.status !== 'running' ? <OutputSlot ready={outputReady} error={outputBody.error ?? legacy.error} output={output} language={languageOfInput(input)} /> : null}
    </>}
  </div>
}

/**
 * Toggle readable view and native payload. Raw is not a hidden degraded mode: it is the actual CLI
 * data and the only way to verify views or find omitted secondary fields. Keep it one click away on
 * every call.
 */
function ViewSwitch({ raw, onChange }: { raw: boolean; onChange: (raw: boolean) => void }) {
  const t = useTranslate()
  return (
    <div className="flex w-fit gap-0.5 rounded-md border border-line bg-sunken p-0.5">
      {[
        { label: t('toolcall.view.readable'), value: false },
        { label: t('toolcall.view.raw'), value: true },
      ].map((mode) => (
        <button
          key={mode.label}
          type="button"
          onClick={() => onChange(mode.value)}
          aria-pressed={raw === mode.value}
          className={cx(
            'rounded px-2 py-0.5 text-[0.6875rem]',
            raw === mode.value ? 'bg-surface-high text-ink' : 'text-ink-faint hover:text-ink',
          )}
        >
          {mode.label}
        </button>
      ))}
    </div>
  )
}

function Payload({
  label,
  content,
  language,
}: {
  label: string
  content: string
  language: string
}) {
  const t = useTranslate()
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[0.6875rem] font-medium tracking-wide text-ink-faint uppercase">
        {label}
      </span>
      {content ? (
        <HighlightedCode
          code={content}
          language={language}
          wrap
          className="max-h-80 overflow-auto rounded-md border border-line bg-sunken p-2 font-mono text-xs"
        />
      ) : (
        <p className="rounded-md border border-line bg-sunken p-2 font-mono text-xs text-ink-faint">
          {t('toolcall.payload.empty')}
        </p>
      )}
    </div>
  )
}

/** Beyond this length tool names overflow the row. */
const NAMES_SHOWN = 3

function summarizeNames(tools: ToolItem[]): string {
  const names = [...new Set(tools.map((tool) => toolLabel(tool.name, tool.presentation)))]
  const shown = names.slice(0, NAMES_SHOWN).join(', ')
  return names.length > NAMES_SHOWN ? `${shown}, +${names.length - NAMES_SHOWN}` : shown
}

/**
 * Collapsed sequence of completed calls. Count failures in the heading so collapse never hides
 * errors. Compare array contents rather than identity: buildRows creates new grouping arrays each
 * delta batch, causing reference-based memoization to miss and redraw every group sixteen times per
 * second.
 */
export const ToolCallGroup = memo(function ToolCallGroup({
  tools, conversationId, complete = true, mayCollapse = true, variant,
}: {
  tools: ToolItem[]
  conversationId: string
  complete?: boolean
  mayCollapse?: boolean
  variant?: ToolStyle
}) {
  const t = useTranslate()
  const [preferredStyle] = useToolStyle()
  const style = variant ?? preferredStyle
  const eligible = complete && tools.length >= 2
  const [collapsed, setCollapsed] = useState(eligible && mayCollapse)
  const [manual, setManual] = useState(false)
  const [pinnedIntent, setPinnedIntent] = useState(false)
  const [opened, setOpened] = useState<Set<string>>(() => new Set())
  const onOpenChange = useCallback((id: string, open: boolean) => {
    setOpened((previous) => {
      const next = new Set(previous)
      if (open) next.add(id)
      else next.delete(id)
      return next
    })
  }, [])
  // Le lecteur garde la main : une ouverture manuelle ou une lecture plus haut bloque le repli.
  useLayoutEffect(() => {
    if (eligible && mayCollapse && !manual && !pinnedIntent && opened.size === 0) setCollapsed(true)
  }, [eligible, mayCollapse, manual, pinnedIntent, opened.size])
  const folded = eligible && collapsed
  const header = folded || manual
  const failed = tools.filter((tool) => tool.status === 'failed').length
  const interrupted = tools.filter((tool) => tool.status === 'interrupted').length
  const total = tools.reduce((sum, tool) => sum + (tool.durationMs ?? 0), 0)
  const sillage = tools.filter((tool) => toolOrigin(tool.name, tool.presentation).kind === 'sillage').length
  const external = tools.filter((tool) => toolOrigin(tool.name, tool.presentation).kind === 'mcp').length
  const servers = [...new Set(tools.map((tool) => toolOrigin(tool.name, tool.presentation)).filter((origin) => origin.kind === 'mcp').map((origin) => origin.server))].join(', ')

  return <div className={`sg-tool-sequence sg-tools-${style}`} data-thread-anchor={`tools-${tools[0]?.id}`} data-tool-sequence data-folded={folded}>
    {header ? <button type="button" className="sg-tool-group-heading" aria-expanded={!folded}
      onClick={() => { setManual(true); setCollapsed(!folded) }}>
      <ChevronRight size={14} className={cx('shrink-0 text-ink-faint', !folded && 'rotate-90')} />
      <span className="shrink-0 font-medium">{t(tools.length > 1 ? 'toolcall.group.count.other' : 'toolcall.group.count.one', { count: tools.length })}</span>
      <span className="min-w-0 flex-1 truncate text-xs text-ink-faint" title={summarizeNames(tools)}>{summarizeNames(tools)}</span>
      {sillage ? <span className="sg-origin-badge text-accent" title={t('toolStyle.origin.sillage', { count: sillage })}><Logo size={16} />{sillage}</span> : null}
      {external ? <span className="sg-origin-badge" title={servers} aria-label={`${t('toolStyle.origin.mcp', { count: external })}: ${servers}`}><span className="sg-mcp-mark">MCP</span>{external}</span> : null}
      {failed > 0 ? <span className="shrink-0 text-xs text-critical">{t(failed > 1 ? 'toolcall.group.failed.other' : 'toolcall.group.failed.one', { count: failed })}</span> : null}
      {interrupted > 0 ? <span className="shrink-0 text-xs text-ink-faint" title={t('toolStyle.interrupted', { count: interrupted })}><CircleSlash size={13} />{interrupted}</span> : null}
      {total > 0 ? <span className="sg-tool-duration text-[0.6875rem] text-ink-faint">{formatDuration(total)}</span> : null}
    </button> : null}
    {!folded ? <div className="sg-tool-list">
      {style === 'intent' ? intentSections(tools).map((section) => <IntentSection key={section[0]!.id} label={t(INTENT_LABELS[toolIntent(section[0]!)])} count={section.length} onInteract={() => setPinnedIntent(true)}>
        {section.map((tool) => <ToolCall key={tool.id} tool={tool} conversationId={conversationId} variant={style} onOpenChange={onOpenChange} />)}
      </IntentSection>) : tools.map((tool) => <ToolCall key={tool.id} tool={tool} conversationId={conversationId} variant={style} onOpenChange={onOpenChange} />)}
    </div> : null}
  </div>
}, (previous, next) => previous.conversationId === next.conversationId && previous.complete === next.complete && previous.mayCollapse === next.mayCollapse && previous.variant === next.variant && previous.tools.length === next.tools.length && previous.tools.every((tool, index) => tool === next.tools[index]))

/** Des catégories locales, sans générer de titres ni prétendre connaître l’intention du modèle. */
function intentSections(tools: ToolItem[]): ToolItem[][] {
  const sections: ToolItem[][] = []
  for (const tool of tools) {
    const last = sections.at(-1)
    if (last && toolIntent(last[0]!) === toolIntent(tool)) last.push(tool)
    else sections.push([tool])
  }
  return sections
}
function IntentSection({ label, count, onInteract, children }: { label: string; count: number; onInteract: () => void; children: ReactNode }) {
  const [open, setOpen] = useState(true)
  return <div>
    <button type="button" className="sg-tool-intent flex w-full items-center gap-2 text-left" aria-expanded={open} onClick={() => { onInteract(); setOpen(!open) }}>
      <ChevronRight size={12} className={cx(open && 'rotate-90')} /><span className="flex-1">{label}</span><span className="text-ink-faint">{count}</span>
    </button>
    <div hidden={!open} className={open ? 'sg-tool-list' : undefined}>{children}</div>
  </div>
}
