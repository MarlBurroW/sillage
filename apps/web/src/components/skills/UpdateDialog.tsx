import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { LibrarySkillDto } from '@sillage/protocol'
import { parseUnifiedDiff } from '../../lib/diff'
import { useTranslate } from '../../lib/i18n'
import { shortCommit, useApplySkillUpdate, useSkillUpdate } from '../../lib/skill-sources'
import { DiffHunks } from '../DiffHunks'
import { Banner, Button, IconButton } from '../ui'

/**
 * Preview updates before applying: installed skill left, source right. Show local edits as content
 * to be lost and explain the warning plainly.
 */
export function UpdateDialog({
  open,
  onClose,
  skill,
  canWrite,
}: {
  open: boolean
  onClose: () => void
  skill: LibrarySkillDto
  canWrite: boolean
}) {
  const t = useTranslate()
  const { data, isLoading, isFetching, error } = useSkillUpdate(skill.id, open)
  const apply = useApplySkillUpdate()
  const [overwrite, setOverwrite] = useState(false)
  const close = () => { setOverwrite(false); onClose() }
  const modified = data?.skill.locallyModified ?? skill.locallyModified
  const files = useMemo(() => (data ? parseUnifiedDiff(data.patch) : []), [data])

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next && !apply.isPending) close() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/35 backdrop-blur-sm" />
        <Dialog.Content
          aria-describedby={undefined}
          className="surface fixed inset-x-0 bottom-0 z-50 flex h-[92dvh] flex-col rounded-t-2xl border border-line shadow-pop sm:inset-x-auto sm:top-1/2 sm:bottom-auto sm:left-1/2 sm:h-[85dvh] sm:w-[min(960px,calc(100vw-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl"
        >
          <header className="flex shrink-0 items-center gap-3 border-b border-line px-5 py-3">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="break-words text-lg font-semibold">{t('skills.update.title', { name: skill.name })}</Dialog.Title>
              {data ? (
                <p className="break-words font-mono text-xs text-ink-faint">
                  {skill.origin?.sourceName ?? ''} · {shortCommit(data.fromCommit)} → {shortCommit(data.toCommit)}
                </p>
              ) : null}
            </div>
            <IconButton label={t('skills.dialog.close')} disabled={apply.isPending} onClick={close}>
              <X size={18} />
            </IconButton>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-5">
            {modified ? <Banner tone="caution">{t('skills.update.overwrite')}</Banner> : null}
            {error instanceof Error ? <Banner>{error.message}</Banner> : null}
            {isLoading ? <p className="text-sm text-ink-faint">{t('skills.files.loading')}</p> : null}
            {data && files.length === 0 ? <p className="text-sm text-ink-faint">{t('skills.update.none')}</p> : null}
            {files.map((file) => (
              <details open key={file.path} className="my-3 overflow-hidden rounded-md border border-line">
                <summary className="cursor-pointer break-words border-b border-line bg-sunken px-3 py-2 font-mono text-xs">
                  <span className="text-ink-soft">{file.path}</span>
                  <span className="ml-3 text-positive">+{file.added}</span>
                  <span className="ml-2 text-critical">−{file.removed}</span>
                </summary>
                {file.status === 'binary' ? (
                  <p className="px-3 py-2 text-xs text-ink-faint">{t('skills.update.binary')}</p>
                ) : (
                  <DiffHunks hunks={file.hunks} path={file.path} />
                )}
              </details>
            ))}
          </div>

          <footer className="flex shrink-0 flex-col gap-2 border-t border-line px-5 py-4">
            {apply.error instanceof Error ? <Banner>{apply.error.message}</Banner> : null}
            {modified && canWrite ? <label className="flex items-start gap-2 text-sm text-ink-soft">
              <input type="checkbox" checked={overwrite} disabled={apply.isPending} onChange={(event) => setOverwrite(event.target.checked)} className="mt-1 size-4 shrink-0 accent-accent" />
              {t('skills.update.confirmOverwrite')}
            </label> : null}
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="ghost" disabled={apply.isPending} onClick={close}>{t('skills.dialog.cancel')}</Button>
              {canWrite ? (
                <Button disabled={!data || isFetching || !!error || apply.isPending || (modified && !overwrite)} onClick={() => apply.mutate(skill.id, { onSuccess: close })}>
                  {apply.isPending ? t('skills.update.applying') : t('skills.update.apply')}
                </Button>
              ) : null}
            </div>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
