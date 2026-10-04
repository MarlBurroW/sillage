import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { useMemo } from 'react'
import type { LibrarySkillDto } from '@sillage/protocol'
import { ApiRequestError } from '../../lib/api'
import { parseUnifiedDiff } from '../../lib/diff'
import { useTranslate } from '../../lib/i18n'
import { shortCommit, useApplySkillUpdate, useSkillUpdate } from '../../lib/skill-sources'
import { DiffHunks } from '../DiffHunks'
import { Banner, Button, IconButton } from '../ui'

/**
 * Ce qu'une mise à jour changerait, avant de l'appliquer : le skill installé à gauche,
 * la source à droite. Une modification locale y apparaît comme ce qui sera perdu, et
 * l'avertissement le dit en clair.
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
  const { data, isLoading, error } = useSkillUpdate(skill.id, open)
  const apply = useApplySkillUpdate()
  const files = useMemo(() => (data ? parseUnifiedDiff(data.patch) : []), [data])

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next && !apply.isPending) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/35 backdrop-blur-sm" />
        <Dialog.Content
          aria-describedby={undefined}
          className="surface fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col rounded-t-2xl border border-line shadow-pop sm:inset-x-auto sm:top-1/2 sm:bottom-auto sm:left-1/2 sm:max-h-[85dvh] sm:w-[min(960px,calc(100vw-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl"
        >
          <header className="flex items-center gap-3 border-b border-line px-5 py-3">
            <div className="min-w-0 flex-1">
              <Dialog.Title className="text-lg font-semibold">{t('skills.update.title', { name: skill.name })}</Dialog.Title>
              {data ? (
                <p className="font-mono text-xs text-ink-faint">
                  {skill.origin?.sourceName ?? ''} · {shortCommit(data.fromCommit)} → {shortCommit(data.toCommit)}
                </p>
              ) : null}
            </div>
            <IconButton label={t('skills.dialog.close')} disabled={apply.isPending} onClick={onClose}>
              <X size={18} />
            </IconButton>
          </header>

          <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-5">
            {skill.locallyModified ? <Banner tone="caution">{t('skills.update.overwrite')}</Banner> : null}
            {error instanceof ApiRequestError ? <Banner>{error.message}</Banner> : null}
            {isLoading ? <p className="text-sm text-ink-faint">{t('skills.files.loading')}</p> : null}
            {data && files.length === 0 ? <p className="text-sm text-ink-faint">{t('skills.update.none')}</p> : null}
            {files.map((file) => (
              <div key={file.path} className="overflow-hidden rounded-md border border-line">
                <p className="flex items-center gap-2 border-b border-line bg-sunken px-3 py-1.5 font-mono text-xs">
                  <span className="min-w-0 flex-1 truncate text-ink-soft">{file.path}</span>
                  <span className="text-positive">+{file.added}</span>
                  <span className="text-critical">−{file.removed}</span>
                </p>
                {file.status === 'binary' ? (
                  <p className="px-3 py-2 text-xs text-ink-faint">{t('skills.update.binary')}</p>
                ) : (
                  <DiffHunks hunks={file.hunks} path={file.path} />
                )}
              </div>
            ))}
          </div>

          <footer className="flex flex-col gap-2 border-t border-line px-5 py-4">
            {apply.error instanceof ApiRequestError ? <Banner>{apply.error.message}</Banner> : null}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" disabled={apply.isPending} onClick={onClose}>{t('skills.dialog.cancel')}</Button>
              {canWrite ? (
                <Button disabled={!data || apply.isPending} onClick={() => apply.mutate(skill.id, { onSuccess: onClose })}>
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
