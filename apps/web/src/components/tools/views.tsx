import { Circle, CircleCheck, CircleDot } from 'lucide-react'
import type { ReactNode } from 'react'
import type { ToolItem } from '../../lib/chat-fold'
import { parseUnifiedDiff } from '../../lib/diff'
import { languageFromPath } from '../../lib/highlight'
import { translate, type MessageKey } from '../../lib/i18n'
import { DiffHunks } from '../DiffHunks'
import { Markdown } from '../chat/Markdown'
import { ImageGallery } from '../chat/ImageViewer'
import { cx } from '../ui'
import { Code, Empty, Plain, Section } from './parts'
import { fields, flag, imageBlocks, list, outputLines, outputText, scalar, stripLineNumbers, text } from './payload'

/**
 * Readable tool-call views show the action rather than native encoding: highlighted shell commands,
 * checked task lists, or diffs rather than JSON objects and escaped strings. Return null for
 * unknown payloads so registry.tsx falls back to generic then raw views. Full native payload always
 * remains accessible: views may choose what to show but never be the only available representation.
 */
export type ToolView = (tool: ToolItem) => ReactNode

/** True before output exists: do not show an empty block. */
function pending(tool: ToolItem): boolean {
  return tool.status === 'running'
}

/** Final output or live CLI execution buffer. */
function TextOutput({ tool, label = translate('tool.output.label') }: { tool: ToolItem; label?: string }) {
  if (pending(tool) && tool.output == null) return null

  const content = outputText(tool.output)
  if (content === null || content.length === 0) {
    return (
      <Section label={label}>
        <Empty>{translate('tool.output.empty')}</Empty>
      </Section>
    )
  }

  return (
    <Section label={label}>
      <Plain content={content} tone={tool.status === 'failed' ? 'text-critical' : undefined} />
    </Section>
  )
}

const bash: ToolView = (tool) => {
  const command = text(tool.input, 'command')
  if (command === null) return null

  const hints = [
    text(tool.input, 'cwd'),
    flag(tool.input, 'run_in_background') ? translate('tool.bash.background') : null,
  ].filter((hint): hint is string => hint !== null)

  return (
    <>
      <Section label={translate('tool.bash.command')} hint={hints.join(' · ')}>
        <Code content={command} language="bash" wrap />
      </Section>
      <TextOutput tool={tool} />
    </>
  )
}

const read: ToolView = (tool) => {
  const path = text(tool.input, 'file_path') ?? text(tool.input, 'path')
  if (path === null) return null

  const offset = scalar(tool.input, 'offset')
  const limit = scalar(tool.input, 'limit')
  const hint = [
    path,
    offset === null ? null : translate('tool.read.fromLine', { line: offset }),
    limit === null ? null : translate('tool.read.lines', { count: limit }),
  ]
    .filter((part): part is string => part !== null)
    .join(' · ')

  const images = pending(tool) ? [] : imageBlocks(tool.output)
  if (images.length > 0) {
    return (
      <Section label={translate('tool.read.content')} hint={hint}>
        <ImageGallery images={images.map((image) => ({ src: `data:${image.mediaType};base64,${image.data}`, alt: path }))} />
      </Section>
    )
  }

  const content = pending(tool) ? null : outputText(tool.output)
  const stripped = content === null ? null : stripLineNumbers(content)

  return (
    <Section label={translate('tool.read.content')} hint={hint}>
      {content === null ? (
        <Empty>{translate('tool.read.loading')}</Empty>
      ) : stripped === null ? (
        <Plain content={content} />
      ) : (
        // Remove CLI line-number gutters to recover highlightable code and useful copy/paste.
        <Code content={stripped} language={languageFromPath(path)} />
      )}
    </Section>
  )
}

/**
 * Codex view_image. The runner attaches base64 images in Claude Read format; if reading failed,
 * explain the remaining path instead of exposing bare JSON.
 */
const viewImage: ToolView = (tool) => {
  const path = text(tool.input, 'path')
  if (path === null) return null

  const images = pending(tool) ? [] : imageBlocks(tool.output)
  return (
    <Section label={translate('tool.viewImage.label')} hint={path}>
      {pending(tool) ? (
        <Empty>{translate('tool.read.loading')}</Empty>
      ) : images.length === 0 ? (
        <Empty>{translate('tool.viewImage.unavailable')}</Empty>
      ) : (
        <ImageGallery images={images.map((image) => ({ src: `data:${image.mediaType};base64,${image.data}`, alt: path }))} />
      )}
    </Section>
  )
}

const write: ToolView = (tool) => {
  const path = text(tool.input, 'file_path')
  const content = text(tool.input, 'content')
  if (path === null || content === null) return null

  return (
    <Section label={translate('tool.write.label')} hint={path}>
      <Code content={content} language={languageFromPath(path)} />
    </Section>
  )
}

/**
 * Edits in both CLI forms. Claude Code supplies old/new excerpts without previous file state, shown
 * side by side rather than fabricating a full diff with invented line numbers. Codex provides real
 * per-file unified diffs rendered normally.
 */
const edit: ToolView = (tool) => {
  const changes = list(tool.input, 'changes')
  if (changes !== null) return <CodexChanges changes={changes} />

  const path = text(tool.input, 'file_path')
  const before = fields(tool.input)?.old_string
  const after = fields(tool.input)?.new_string
  if (path === null || typeof before !== 'string' || typeof after !== 'string') return null

  const language = languageFromPath(path)

  return (
    <>
      <Section
        label={translate('tool.edit.replaced')}
        hint={[path, flag(tool.input, 'replace_all') ? translate('tool.edit.allOccurrences') : null]
          .filter(Boolean)
          .join(' · ')}
      >
        <Code content={before} language={language} />
      </Section>
      <Section label={translate('tool.edit.by')}>
        <Code content={after} language={language} />
      </Section>
    </>
  )
}

/** Codex change kind in its native vocabulary. */
const CHANGE_LABELS: Record<string, MessageKey> = {
  add: 'tool.change.created',
  delete: 'tool.change.deleted',
  update: 'tool.change.modified',
}

function CodexChanges({ changes }: { changes: unknown[] }) {
  return (
    <>
      {changes.map((change, index) => {
        const path = text(change, 'path') ?? ''
        const diff = text(change, 'diff') ?? ''
        const kind = text(fields(change)?.kind, 'type') ?? 'update'
        const label = translate(CHANGE_LABELS[kind] ?? 'tool.change.modified')

        return (
          <Section key={`${path}-${index}`} label={label} hint={path}>
            {/*
             * Updates contain unified diffs missing only file headers; additions/deletions contain
             * raw contents with nothing to compare.
             */}
            {kind === 'update' ? (
              <div className="overflow-hidden rounded-md border border-line bg-sunken">
                {parseUnifiedDiff(`diff --git a/${path} b/${path}\n${diff}`).map((file) => (
                  <DiffHunks key={file.path} hunks={file.hunks} path={path} />
                ))}
              </div>
            ) : (
              <Code content={diff} language={languageFromPath(path)} />
            )}
          </Section>
        )
      })}
    </>
  )
}

/** Searches returning one result per output line. */
function matchesView(inputLabelKey: MessageKey, keys: string[]): ToolView {
  return (tool) => {
    const query = keys.map((key) => text(tool.input, key)).find((value) => value !== null)
    if (!query) return null

    const scope = [text(tool.input, 'path'), text(tool.input, 'glob')]
      .filter((hint): hint is string => hint !== null)
      .join(' · ')
    const lines = pending(tool) ? null : outputLines(tool.output)

    return (
      <>
        <Section label={translate(inputLabelKey)} hint={scope || null}>
          <Plain content={query} />
        </Section>
        {pending(tool) ? null : (
          <Section
            label={translate('tool.search.results')}
            hint={
              lines === null
                ? null
                : lines.length > 1
                  ? translate('tool.search.lineCountMany', { count: lines.length })
                  : translate('tool.search.lineCountOne', { count: lines.length })
            }
          >
            {lines === null ? (
              <Empty>{translate('tool.search.noResults')}</Empty>
            ) : (
              <Plain content={lines.join('\n')} />
            )}
          </Section>
        )}
      </>
    )
  }
}

/** Task-state icon and tone in progression order. */
interface TodoState {
  icon: ReactNode
  tone: string
}

const WAITING: TodoState = { icon: <Circle size={12} />, tone: 'text-ink-faint' }

const TODO_STATES: Record<string, TodoState> = {
  pending: WAITING,
  in_progress: { icon: <CircleDot size={12} />, tone: 'text-accent' },
  completed: { icon: <CircleCheck size={12} />, tone: 'text-positive' },
}

const todos: ToolView = (tool) => {
  const entries = list(tool.input, 'todos')
  if (entries === null) return null

  return (
    <Section label={translate('tool.todo.label')}>
      <ul className="flex flex-col gap-1 rounded-md border border-line bg-sunken p-2">
        {entries.map((entry, index) => {
          const status = text(entry, 'status') ?? 'pending'
          const state = TODO_STATES[status] ?? WAITING

          return (
            <li key={index} className="flex items-start gap-2 text-xs">
              <span className={cx('mt-0.5 shrink-0', state.tone)}>{state.icon}</span>
              <span
                className={cx(
                  'min-w-0',
                  status === 'completed' ? 'text-ink-faint line-through' : 'text-ink-soft',
                )}
              >
                {text(entry, 'content') ?? text(entry, 'activeForm') ?? ''}
              </span>
            </li>
          )
        })}
      </ul>
    </Section>
  )
}

/** Subagent reports are Markdown messages, not logs. */
const subAgent: ToolView = (tool) => {
  const prompt = text(tool.input, 'prompt')
  if (prompt === null) return null

  const report = pending(tool) ? null : outputText(tool.output)

  return (
    <>
      <Section label={translate('tool.subagent.instructions')} hint={text(tool.input, 'subagent_type')}>
        <Plain content={prompt} />
      </Section>
      {report === null ? null : (
        <Section label={translate('tool.subagent.report')}>
          <div className="max-h-80 overflow-auto rounded-md border border-line bg-sunken px-2 py-1.5">
            <Markdown text={report} />
          </div>
        </Section>
      )}
    </>
  )
}

const webFetch: ToolView = (tool) => {
  const url = text(tool.input, 'url')
  if (url === null) return null

  const question = text(tool.input, 'prompt')
  const answer = pending(tool) ? null : outputText(tool.output)

  return (
    <>
      <Section label={translate('tool.webfetch.page')}>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="truncate rounded-md border border-line bg-sunken p-2 font-mono text-xs text-accent underline"
        >
          {url}
        </a>
      </Section>
      {question === null ? null : (
        <Section label={translate('tool.webfetch.question')}>
          <Plain content={question} />
        </Section>
      )}
      {answer === null ? null : (
        <Section label={translate('tool.webfetch.answer')}>
          <div className="max-h-80 overflow-auto rounded-md border border-line bg-sunken px-2 py-1.5">
            <Markdown text={answer} />
          </div>
        </Section>
      )}
    </>
  )
}

const plan: ToolView = (tool) => {
  const content = text(tool.input, 'plan')
  if (content === null) return null

  return (
    <Section label={translate('tool.plan.label')}>
      <div className="max-h-80 overflow-auto rounded-md border border-line bg-sunken px-2 py-1.5">
        <Markdown text={content} />
      </div>
    </Section>
  )
}

/**
 * Fallback for tools without dedicated views: MCP, future CLI tools, and unexpected payloads. Short
 * fields fit definition lists for glanceable parameters; long or structured fields get blocks.
 * Indented JSON contained the same information but required reading it all.
 */
export const genericView: ToolView = (tool) => {
  const input = fields(tool.input)
  const entries = input === null ? [] : Object.entries(input)
  const short = entries.filter(([, value]) => isShort(value))
  const long = entries.filter(([, value]) => !isShort(value))
  const output = pending(tool) ? null : tool.output
  const images = imageBlocks(output)
  const imageText = images.length > 0 ? outputText(Array.isArray(output) ? output : fields(output)?.content) : null

  if (entries.length === 0 && output === null) return null

  return (
    <>
      {short.length > 0 ? (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-md border border-line bg-sunken p-2 text-xs">
          {short.map(([key, value]) => (
            <div key={key} className="col-span-2 grid grid-cols-subgrid">
              <dt className="text-ink-faint">{key}</dt>
              <dd className="min-w-0 truncate font-mono text-ink-soft">{String(value)}</dd>
            </div>
          ))}
        </dl>
      ) : null}

      {long.map(([key, value]) => (
        <Section key={key} label={key}>
          {typeof value === 'string' ? (
            <Plain content={value} />
          ) : (
            <Code content={JSON.stringify(value, null, 2)} language="json" />
          )}
        </Section>
      ))}

      {images.length > 0 ? <Section label={translate('tool.viewImage.label')}>
        <ImageGallery images={images.map((image) => ({ src: `data:${image.mediaType};base64,${image.data}`, alt: translate('image.title') }))} />
        {imageText && <Plain content={imageText} />}
      </Section> : output === null ? null : typeof output === 'string' || Array.isArray(output) ? (
        <TextOutput tool={tool} />
      ) : (
        <Section label={translate('tool.output.label')}>
          <Code content={JSON.stringify(output, null, 2)} language="json" />
        </Section>
      )}
    </>
  )
}

/** Short enough for a list row without its own block. */
function isShort(value: unknown): boolean {
  if (value === null || typeof value === 'object') return false
  const rendered = String(value)
  return rendered.length <= 80 && !rendered.includes('\n')
}

/**
 * Views by normalized log tool name: adapters map Codex execution to Bash and file changes to Edit
 * (I3). Task and Agent identify the same tool depending on CLI version.
 */
export const VIEWS: Record<string, ToolView> = {
  Bash: bash,
  Read: read,
  ViewImage: viewImage,
  Write: write,
  Edit: edit,
  Glob: matchesView('tool.search.patternLabel', ['pattern']),
  Grep: matchesView('tool.search.patternLabel', ['pattern']),
  WebSearch: matchesView('tool.search.queryLabel', ['query']),
  TodoWrite: todos,
  Task: subAgent,
  Agent: subAgent,
  WebFetch: webFetch,
  ExitPlanMode: plan,
}
