import { CircleAlert, X } from 'lucide-react'
import { formatBytes } from '../../../lib/attachments'
import { translate, useTranslate } from '../../../lib/i18n'
import { dismissUpload, useUploads, type Upload as UploadItem } from '../../../lib/uploads'
import { cx } from '../../ui'
import { TooltipButton } from '../../ui/Tooltip'

/**
 * Uploads at column bottom rather than top: uploading directories does not shift the tree, and
 * dropped files appear in place without jumping. Success disappears automatically; errors wait to
 * be read.
 */
export function UploadQueue({ scope }: { scope: string }) {
  const t = useTranslate()
  const uploads = useUploads(scope)
  if (uploads.length === 0) return null

  return (
    <ul className="sticky bottom-0 z-10 mt-auto border-t border-line bg-surface px-2 py-1.5">
      {uploads.map((upload) => (
        <li key={upload.id} className="flex flex-col gap-0.5 py-0.5">
          <div className="flex items-baseline gap-1.5 text-[0.6875rem]">
            <span
              className={cx(
                'min-w-0 flex-1 truncate',
                upload.status === 'error' ? 'text-critical' : 'text-ink-soft',
              )}
              title={upload.path}
            >
              {upload.label}
            </span>
            <span className="shrink-0 text-ink-faint">{statusOf(upload)}</span>
            <TooltipButton
              type="button"
              onClick={() => dismissUpload(upload.id)}
              aria-label={
                upload.status === 'sending' || upload.status === 'pending'
                  ? t('uploads.cancel')
                  : t('uploads.dismiss')
              }
              className="shrink-0 rounded p-0.5 text-ink-faint hover:text-ink"
            >
              <X size={11} />
            </TooltipButton>
          </div>

          {upload.status === 'error' ? (
            <p className="flex items-start gap-1 text-[0.6875rem] text-critical">
              <CircleAlert size={11} className="mt-0.5 shrink-0" />
              <span className="min-w-0">{upload.error}</span>
            </p>
          ) : (
            // Zero size has no fraction: show a full bar rather than divide by zero; the file is already written anyway.
            <div className="h-1 overflow-hidden rounded-full bg-surface-high">
              <div
                className={cx(
                  'h-full rounded-full transition-[width]',
                  upload.status === 'done' ? 'bg-positive' : 'bg-accent',
                )}
                style={{ width: `${percentOf(upload)}%` }}
              />
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}

function percentOf(upload: UploadItem): number {
  if (upload.status === 'done' || upload.sizeBytes === 0) return 100
  return Math.min(100, Math.round((upload.sentBytes / upload.sizeBytes) * 100))
}

function statusOf(upload: UploadItem): string {
  if (upload.status === 'error') return translate('uploads.status.error')
  if (upload.status === 'done') return translate('uploads.status.done')
  if (upload.status === 'pending') return translate('uploads.status.pending')
  return translate('uploads.status.sending', {
    sent: formatBytes(upload.sentBytes),
    total: formatBytes(upload.sizeBytes),
  })
}
