import { ChevronRight, Loader, Undo2, X, FileCode } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { CheckpointFile } from '@sillage/protocol'
import type { TurnCheckpoint } from '../../../lib/chat-fold'
import { sumLines, useCheckpointFileDiff } from '../../../lib/checkpoints'
import { parseUnifiedDiff } from '../../../lib/diff'
import { useTranslate } from '../../../lib/i18n'
import { DiffHunks } from '../../DiffHunks'
import { Button, IconButton, cx } from '../../ui'
import { CHANGE_KINDS, splitPath } from './change-kind'
import { useGitPane } from './context'

/**
 * Les changements d'un seul tour, dans l'onglet Git.
 *
 * Remplace le dépôt tout entier le temps qu'on le regarde : c'est la même question que
 * la section Changements, « qu'est-ce qui a changé ? », posée à un tour plutôt qu'au
 * répertoire de travail. Les diffs viennent des deux captures et non du disque, que le
 * tour suivant a pu réécrire.
 */
export function TurnChangesView({
  conversationId,
  checkpoint,
  label,
  canRestore,
  onRestore,
  onClose,
}: {
  conversationId: string
  checkpoint: TurnCheckpoint
  /** Début du message qui a ouvert le tour, pour dire de quel tour il s'agit. */
  label: string | null
  canRestore: boolean
  onRestore: (checkpoint: TurnCheckpoint) => void
  onClose: () => void
}) {
  const t = useTranslate()
  const { added, removed } = sumLines(checkpoint)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="surface sticky top-0 z-10 flex items-center gap-1.5 border-b border-line px-2.5 py-1.5">
        <span className="min-w-0 flex-1">
          <span className="block text-[0.6875rem] font-semibold tracking-wide text-ink-faint uppercase">
            {t('checkpoint.view.title')}
          </span>
          {label ? (
            <span className="block truncate text-[0.75rem] text-ink-soft" title={label}>
              {label}
            </span>
          ) : null}
        </span>
        <IconButton label={t('checkpoint.view.close')} size="sm" onClick={onClose}>
          <X size={14} />
        </IconButton>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line/60 px-2.5 py-1.5 text-[0.6875rem] text-ink-faint">
        <span>
          {checkpoint.files.length > 1
            ? t('changes.files.countMany', { count: checkpoint.files.length })
            : t('changes.files.countOne', { count: checkpoint.files.length })}
        </span>
        {added > 0 ? <span className="font-mono text-positive">+{added}</span> : null}
        {removed > 0 ? <span className="font-mono text-critical">-{removed}</span> : null}
        {checkpoint.excluded > 0 ? (
          <span title={t('checkpoint.view.excluded.hint')}>
            {t('checkpoint.view.excluded', { count: checkpoint.excluded })}
          </span>
        ) : null}
        {checkpoint.truncated ? <span>{t('checkpoint.summary.truncated')}</span> : null}
      </div>

      {checkpoint.files.length === 0 ? (
        <p className="px-2.5 py-2 text-xs text-ink-faint">{t('checkpoint.view.empty')}</p>
      ) : null}

      {checkpoint.files.map((file) => (
        <FileRow key={`${file.path}\0${file.oldPath ?? ''}`} conversationId={conversationId} checkpointKey={checkpoint.key} file={file} />
      ))}

      {canRestore ? (
        <div className="flex flex-col gap-1.5 border-t border-line/60 p-2.5">
          <Button size="sm" variant="secondary" icon={<Undo2 size={14} />} onClick={() => onRestore(checkpoint)}>
            {t('checkpoint.restore.action')}
          </Button>
          {checkpoint.restored ? (
            <p className="text-[0.6875rem] text-ink-faint">{t('checkpoint.restored.badge')}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** Un fichier changé par le tour, dépliable sur son diff. Même ligne que l'onglet Git. */
function FileRow({
  conversationId,
  checkpointKey,
  file,
}: {
  conversationId: string
  checkpointKey: string
  file: CheckpointFile
}) {
  const t = useTranslate()
  const { openFile } = useGitPane()
  const [open, setOpen] = useState(false)
  const kind = CHANGE_KINDS[file.kind]
  const { dir, name } = splitPath(file.path)

  return (
    <div className="border-b border-line/60">
      <div className="group/change flex items-center gap-0.5 pr-1 hover:bg-surface-high" data-path={file.path}>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="flex h-8 min-w-0 flex-1 items-center gap-1.5 py-1 pl-2 text-left"
        >
          <ChevronRight size={12} className={cx('shrink-0 text-ink-faint transition-transform', open && 'rotate-90')} />
          <span
            className={cx('w-3 shrink-0 text-center font-mono text-[0.625rem] font-semibold', kind.tone)}
            title={t(kind.label)}
            aria-label={t(kind.label)}
          >
            {kind.letter}
          </span>
          <span className="min-w-0 flex-1 truncate text-[0.8125rem]" title={file.path}>
            <span className="text-ink-faint">{dir}</span>
            <span className="text-ink-soft">{name}</span>
            {file.oldPath ? (
              <span className="text-ink-faint"> · {t('git.changes.renamedFrom', { path: file.oldPath })}</span>
            ) : null}
          </span>
          {file.added ? <span className="shrink-0 font-mono text-[0.625rem] text-positive">+{file.added}</span> : null}
          {file.removed ? <span className="shrink-0 font-mono text-[0.625rem] text-critical">-{file.removed}</span> : null}
        </button>
        {openFile && file.kind !== 'deleted' ? (
          <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/change:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
            <IconButton label={t('git.changes.open')} size="sm" onClick={() => openFile(file.path)}>
              <FileCode size={14} />
            </IconButton>
          </div>
        ) : null}
      </div>
      {open ? <FileDiffBody conversationId={conversationId} checkpointKey={checkpointKey} file={file} /> : null}
    </div>
  )
}

function FileDiffBody({
  conversationId,
  checkpointKey,
  file,
}: {
  conversationId: string
  checkpointKey: string
  file: CheckpointFile
}) {
  const t = useTranslate()
  const { data, error, isPending } = useCheckpointFileDiff(conversationId, checkpointKey, file.path, file.oldPath, true)
  const parsed = useMemo(() => (data ? (parseUnifiedDiff(data.patch)[0] ?? null) : null), [data])

  return (
    <div className="border-t border-line/60 bg-sunken/40">
      {isPending ? (
        <p className="flex items-center gap-1.5 px-2.5 py-1.5 text-[0.6875rem] text-ink-faint">
          <Loader size={11} className="animate-spin" />
          {t('git.changes.diffLoading')}
        </p>
      ) : null}
      {error ? (
        <p className="px-2.5 py-1.5 text-[0.6875rem] text-critical">
          {error instanceof Error ? error.message : t('changes.diff.error')}
        </p>
      ) : null}
      {data && (!parsed || parsed.hunks.length === 0) ? (
        <p className="px-2.5 py-1.5 text-[0.6875rem] text-ink-faint">
          {parsed?.status === 'binary' ? t('changes.file.binary') : t('git.changes.diffEmpty')}
        </p>
      ) : null}
      {parsed && parsed.hunks.length > 0 ? <DiffHunks hunks={parsed.hunks} path={file.path} /> : null}
      {data?.truncated ? (
        <p className="px-2.5 py-1.5 text-[0.6875rem] text-caution">{t('changes.diff.truncated')}</p>
      ) : null}
    </div>
  )
}
