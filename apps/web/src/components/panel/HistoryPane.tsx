import { PanelEmptyState } from './PanelEmptyState'
import { ChevronRight, Loader } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { EditTurn, EditedFile } from '../../lib/chat-fold'
import { parseUnifiedDiff } from '../../lib/diff'
import { useEditDiff } from '../../lib/edits'
import { languageFromPath } from '../../lib/highlight'
import { locale, useTranslate } from '../../lib/i18n'
import { DiffHunks } from '../DiffHunks'
import { HighlightedCode } from '../chat/HighlightedCode'
import { cx } from '../ui'
import { ACTIONS, SectionTitle } from './diff-parts'

/** Time only: history covers one conversation rather than successive days. */
function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })
}

/**
 * Agent-written changes by turn, derived from the log rather than repository. This is history, not
 * current state: disk may have changed and commits may exist. Git answers the current-state
 * question.
 */
export function HistoryPane({
  conversationId,
  turns,
  onOpenFile,
}: {
  conversationId: string
  turns: EditTurn[]
  /** Switch to Files: opening unseen tabs appears ineffective. */
  onOpenFile: (path: string) => void
}) {
  const t = useTranslate()

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto pb-safe">
      <SectionTitle>{t('changes.history.title')}</SectionTitle>

      {turns.length === 0 ? (
        <PanelEmptyState>
          <p className="text-xs text-ink-faint">{t('changes.history.empty')}</p>
        </PanelEmptyState>
      ) : null}

      {/* Newest first: the turn whose result users just saw. */}
      {[...turns].reverse().map((turn) => (
        <HistoryTurn
          key={turn.id}
          conversationId={conversationId}
          turn={turn}
          onOpenFile={onOpenFile}
        />
      ))}
    </div>
  )
}

function HistoryTurn({
  conversationId,
  turn,
  onOpenFile,
}: {
  conversationId: string
  turn: EditTurn
  onOpenFile: (path: string) => void
}) {
  const t = useTranslate()
  const [open, setOpen] = useState(false)

  return (
    <div className="shrink-0 border-b border-line/60">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left hover:bg-surface-high"
      >
        <ChevronRight
          size={12}
          className={cx('shrink-0 text-ink-faint transition-transform', open && 'rotate-90')}
        />
        <span className="shrink-0 font-mono text-[0.625rem] text-ink-faint">
          {formatTime(turn.ts)}
        </span>
        <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-ink-soft" title={turn.label || t('activity.turn.noMessage')}>
          {turn.label || t('activity.turn.noMessage')}
        </span>
        <span className="shrink-0 text-[0.625rem] text-ink-faint">
          {turn.files.length > 1
            ? t('changes.files.countMany', { count: turn.files.length })
            : t('changes.files.countOne', { count: turn.files.length })}
        </span>
      </button>

      {open ? (
        <ul className="border-t border-line/60 py-0.5">
          {turn.files.map((file) => (
            <li key={file.path}>
              <HistoryFile conversationId={conversationId} file={file} onOpenFile={onOpenFile} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

/**
 * Past-turn file expandable to changes. Git cannot provide historical tool state after further disk
 * changes; reconstruct native call payloads, limited by EditDiffDto but the only faithful source
 * for that moment.
 */
function HistoryFile({
  conversationId,
  file,
  onOpenFile,
}: {
  conversationId: string
  file: EditedFile
  onOpenFile: (path: string) => void
}) {
  const t = useTranslate()
  const [open, setOpen] = useState(false)

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 py-1 pr-2 pl-5 text-left hover:bg-surface-high"
      >
        <ChevronRight
          size={11}
          className={cx('shrink-0 text-ink-faint transition-transform', open && 'rotate-90')}
        />
        <span className={cx('shrink-0', ACTIONS[file.action].tone)}>
          {ACTIONS[file.action].icon}
        </span>
        <span
          className={cx(
            'min-w-0 flex-1 truncate text-[0.75rem]',
            file.action === 'deleted' ? 'text-ink-faint line-through' : 'text-ink-soft',
          )}
          title={file.path}
        >
          {file.path}
        </span>
        {/* Count only multiple passes; repeated ones add no information. */}
        {file.toolCallIds.length > 1 ? (
          <span className="shrink-0 text-[0.625rem] text-ink-faint">
            {t('changes.file.passes', { count: file.toolCallIds.length })}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="border-y border-line/60 bg-sunken/40">
          {file.toolCallIds.map((toolCallId, index) => (
            <EditDiff
              key={toolCallId}
              conversationId={conversationId}
              toolCallId={toolCallId}
              path={file.path}
              rank={file.toolCallIds.length > 1 ? index + 1 : null}
            />
          ))}

          {/* Deleted files have nothing to open: omit actions instead of opening failing tabs. */}
          {file.action === 'deleted' ? null : (
            <button
              type="button"
              onClick={() => onOpenFile(file.path)}
              className="px-2.5 py-1.5 text-[0.6875rem] text-ink-faint underline hover:text-ink"
            >
              {t('changes.file.open')}
            </button>
          )}
        </div>
      ) : null}
    </div>
  )
}

/** An edit reconstructed from its call payload. */
function EditDiff({
  conversationId,
  toolCallId,
  path,
  rank,
}: {
  conversationId: string
  toolCallId: string
  path: string
  /** Pass number when files are edited repeatedly in one turn. */
  rank: number | null
}) {
  const t = useTranslate()
  const { data, error, isPending } = useEditDiff(conversationId, toolCallId, path)
  const files = useMemo(() => (data?.kind === 'patch' ? parseUnifiedDiff(data.patch) : []), [data])

  if (isPending) {
    return (
      <p className="flex items-center gap-1.5 px-2.5 py-1.5 text-[0.6875rem] text-ink-faint">
        <Loader size={11} className="animate-spin" />
        {t('changes.edit.loading')}
      </p>
    )
  }

  if (error || !data) {
    return (
      <p className="px-2.5 py-1.5 text-[0.6875rem] text-critical">
        {error instanceof Error ? error.message : t('changes.edit.error')}
      </p>
    )
  }

  return (
    <div>
      {rank === null && !data.partial && data.kind === 'patch' ? null : (
        <p className="px-2.5 pt-1.5 text-[0.625rem] text-ink-faint">
          {[
            rank === null ? null : t('changes.edit.pass', { rank }),
            data.partial ? t('changes.edit.partial') : null,
            data.reason,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}

      {files.map((entry) => (
        <DiffHunks key={entry.path} hunks={entry.hunks} path={path} />
      ))}

      {/* Written content is still code and receives highlighting without a comparison diff. */}
      {data.kind === 'content' ? (
        <HighlightedCode
          code={data.content}
          language={languageFromPath(path)}
          className="px-2.5 py-1.5 font-mono text-[0.6875rem] text-ink-soft"
        />
      ) : null}
    </div>
  )
}
