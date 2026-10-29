import { useState } from 'react'
import type { WorktreeStatusDto } from '@sillage/protocol'
import { ApiRequestError } from '../lib/api'
import { useTranslate } from '../lib/i18n'
import { useKeepWorktreeFiles } from '../lib/worktrees'
import { Banner, ConfirmDialog } from './ui'

/**
 * Files a merged tree still holds, shown before keeping them. Keeping sends back the fingerprint of
 * this very list: if an agent writes in the meantime, the server refuses rather than hide it.
 */
export function WorktreeLeftoversDialog({
  projectId,
  tree,
  base,
  onClose,
}: {
  projectId: string
  tree: WorktreeStatusDto
  base: string | null
  onClose: () => void
}) {
  const t = useTranslate()
  const keep = useKeepWorktreeFiles(projectId)
  const [error, setError] = useState<string | null>(null)
  const total = tree.modified + tree.untracked
  const hidden = total - tree.files.length

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title={t('worktrees.leftovers.title', { name: tree.name })}
      confirmLabel={t('worktrees.leftovers.keep')}
      busy={keep.isPending}
      confirmDisabled={!tree.fingerprint}
      onConfirm={() => {
        if (!tree.fingerprint) return
        setError(null)
        keep.mutate(
          { path: tree.path, fingerprint: tree.fingerprint },
          {
            onSuccess: onClose,
            onError: (err) => setError(err instanceof ApiRequestError ? err.message : String(err)),
          },
        )
      }}
    >
      <p>{t('worktrees.leftovers.intro', { base: base ?? 'HEAD' })}</p>
      <ul className="flex max-h-60 flex-col gap-1 overflow-y-auto rounded-sm border border-line bg-sunken/40 p-2 text-xs">
        {tree.files.map((file) => (
          <li key={file.path} className="flex min-w-0 items-baseline gap-2">
            <span className="w-16 shrink-0 text-ink-faint">{t(`worktrees.file.${file.kind}`)}</span>
            <span className="min-w-0 font-mono break-all text-ink">{file.path}</span>
          </li>
        ))}
        {hidden > 0 ? <li className="text-ink-faint">{t('worktrees.files.more', { count: hidden })}</li> : null}
      </ul>
      {!tree.fingerprint ? <p className="text-ink-faint">{t('worktrees.leftovers.tooMany')}</p> : null}
      {error ? <Banner>{t('worktrees.leftovers.failed', { message: error })}</Banner> : null}
    </ConfirmDialog>
  )
}
