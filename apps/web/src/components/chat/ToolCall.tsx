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
import { memo, useState, type ReactNode } from 'react'
import { isSpawnTool, type ToolOutputDto } from '@sillage/protocol'
import type { ToolItem } from '../../lib/chat-fold'
import { languageFromPath } from '../../lib/highlight'
import { useTranslate } from '../../lib/i18n'
import { showSubAgent } from '../../lib/panel'
import { useToolOutput } from '../../lib/tool-output'
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
  Glob: <FolderSearch size={14} />,
  Grep: <Search size={14} />,
  WebFetch: <Globe size={14} />,
  WebSearch: <Globe size={14} />,
  TodoWrite: <ListTodo size={14} />,
  Task: <Bot size={14} />,
  Agent: <Bot size={14} />,
  ExitPlanMode: <ListChecks size={14} />,
}

/** mono distinguishes code fragments from prose, which require different reading styles. */
interface ToolSummary {
  text: string
  mono: boolean
}

/**
 * Single-line summary. Prefer descriptions: they explain purpose rather than commands or paths
 * explaining mechanics. Claude Code supplies them for Bash and subagents, more informative than
 * truncated sed ranges. Codex provides none, so fall back to identifying parameters. Commands
 * remain visible beneath expanded input.
 */
function summarize(name: string, input: unknown): ToolSummary | null {
  if (typeof input !== 'object' || input === null) return null
  const fields = input as Record<string, unknown>

  const description = fields.description
  if (typeof description === 'string' && description.length > 0) {
    return { text: description, mono: false }
  }

  const candidates =
    name === 'Bash'
      ? ['command']
      : name === 'WebFetch' || name === 'WebSearch'
        ? ['url', 'query']
        : ['file_path', 'path', 'pattern', 'prompt']

  for (const key of candidates) {
    const value = fields[key]
    if (typeof value === 'string' && value.length > 0) return { text: value, mono: true }
  }
  return null
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
}: {
  tool: ToolItem
  conversationId: string
}) {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const [raw, setRaw] = useState(false)
  const summary = summarize(tool.name, tool.input)

  // Large output is omitted from thread transfers: replay supplies only a preview and the full body
  // loads when this card opens.
  const previewed = tool.outputBytes !== null
  const full = useToolOutput(conversationId, tool.id, open && previewed)
  const ready = !previewed || full.data !== undefined
  const output = outputOf(tool, full.data)
  // Readable views distinguish strings and block arrays in tool.output: previews could briefly show
  // broken images, so wait for the full body rather than render an intermediate state.
  const readable = open && ready ? readableView({ ...tool, output }) : null

  return (
    <div
      className={cx(
        'rounded-md border bg-surface/60 text-sm',
        tool.status === 'failed' ? 'border-critical/40' : 'border-line',
      )}
    >
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left"
      >
        <ChevronRight
          size={14}
          className={cx('shrink-0 text-ink-faint transition-transform', open && 'rotate-90')}
        />
        <span className="shrink-0 text-ink-faint">
          {TOOL_ICONS[tool.name] ?? <Wrench size={14} />}
        </span>
        <span className="shrink-0 font-medium text-ink">{tool.name}</span>
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

        <ToolStatusIcon status={tool.status} />
        {tool.durationMs !== null ? (
          <span className="shrink-0 text-[0.6875rem] text-ink-faint">
            {formatDuration(tool.durationMs)}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="flex flex-col gap-2 border-t border-line px-2.5 py-2">
          {readable ? <ViewSwitch raw={raw} onChange={setRaw} /> : null}

          {readable && !raw ? (
            readable
          ) : (
            <>
              <Payload label={t('toolcall.payload.input')} {...asPayload(tool.input)} />
              {tool.status !== 'running' ? (
                <OutputSlot
                  ready={ready}
                  error={full.error}
                  output={output}
                  language={languageOfInput(tool.input)}
                />
              ) : null}
            </>
          )}
        </div>
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
  const names = [...new Set(tools.map((tool) => tool.name))]
  const shown = names.slice(0, NAMES_SHOWN).join(', ')
  return names.length > NAMES_SHOWN ? `${shown}, +${names.length - NAMES_SHOWN}` : shown
}

/**
 * Collapsed sequence of completed calls. Count failures in the heading so collapse never hides
 * errors. Compare array contents rather than identity: buildRows creates new grouping arrays each
 * delta batch, causing reference-based memoization to miss and redraw every group sixteen times per
 * second.
 */
const ToolCallGroupInner = function ToolCallGroup({
  tools,
  conversationId,
}: {
  tools: ToolItem[]
  conversationId: string
}) {
  const t = useTranslate()
  const [open, setOpen] = useState(false)

  const failed = tools.filter((tool) => tool.status === 'failed').length
  const total = tools.reduce((sum, tool) => sum + (tool.durationMs ?? 0), 0)

  return (
    <div className="rounded-md border border-line bg-surface/60 text-sm">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-2.5 py-2 text-left"
      >
        <ChevronRight
          size={14}
          className={cx('shrink-0 text-ink-faint transition-transform', open && 'rotate-90')}
        />
        <Wrench size={14} className="shrink-0 text-ink-faint" />
        <span className="shrink-0 font-medium text-ink">
          {t(
            tools.length > 1 ? 'toolcall.group.count.other' : 'toolcall.group.count.one',
            { count: tools.length },
          )}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-faint">
          {summarizeNames(tools)}
        </span>

        {failed > 0 ? (
          <span className="shrink-0 text-[0.6875rem] font-medium text-critical">
            {t(
              failed > 1 ? 'toolcall.group.failed.other' : 'toolcall.group.failed.one',
              { count: failed },
            )}
          </span>
        ) : null}
        {total > 0 ? (
          <span className="shrink-0 text-[0.6875rem] text-ink-faint">{formatDuration(total)}</span>
        ) : null}
      </button>

      {open ? (
        <div className="flex flex-col gap-1.5 border-t border-line p-1.5">
          {tools.map((tool) => (
            <ToolCall key={tool.id} tool={tool} conversationId={conversationId} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

export const ToolCallGroup = memo(
  ToolCallGroupInner,
  (prev, next) =>
    prev.conversationId === next.conversationId &&
    prev.tools.length === next.tools.length &&
    // The fold replaces changed call objects, so per-item reference comparison is exact without
    // checking every field.
    prev.tools.every((tool, index) => tool === next.tools[index]),
)
