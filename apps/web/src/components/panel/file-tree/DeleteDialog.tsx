import { useTranslate } from '../../../lib/i18n'
import { ConfirmDialog } from '../../ui'
import type { Picked } from './shared'

/** Confirmation of an irreversible deletion, listing the entries it removes. */
export function DeleteDialog({
  pending,
  onClose,
  onConfirm,
}: {
  /** Entries proposed for deletion, or null when the dialog is closed. */
  pending: Picked[] | null
  onClose: () => void
  onConfirm: (entries: Picked[]) => void
}) {
  const t = useTranslate()

  return (
    <ConfirmDialog
      open={pending !== null}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      title={
        pending && pending.length > 1
          ? t('filetree.delete.confirmMany', { count: pending.length })
          : pending?.[0]?.[1]
            ? t('filetree.delete.confirmFolder')
            : t('filetree.delete.confirmFile')
      }
      confirmLabel={t('filetree.delete.confirm')}
      tone="critical"
      onConfirm={() => {
        if (pending) onConfirm(pending)
        onClose()
      }}
    >
      <ul className="max-h-40 overflow-y-auto font-mono text-xs break-all text-ink">
        {pending?.map(([path]) => <li key={path}>{path}</li>)}
      </ul>
      <p>
        {pending && pending.length > 1
          ? t('filetree.delete.bodyMany')
          : pending?.[0]?.[1]
            ? t('filetree.delete.bodyFolder')
            : t('filetree.delete.bodyFile')}{' '}
        {t('filetree.delete.note')}
      </p>
    </ConfirmDialog>
  )
}
