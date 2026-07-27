import { FileText, Loader, X } from 'lucide-react'
import type { AttachmentDto } from '@sillage/protocol'
import { formatBytes } from '../../lib/attachments'
import { IconButton, cx } from '../ui'

/**
 * Pièces jointes en attente d'envoi, au-dessus de la saisie.
 *
 * Les images sont montrées en vignette : reconnaître une capture d'écran à son nom de
 * fichier est impossible, et c'est le cas d'usage le plus fréquent depuis un téléphone.
 */
export function AttachmentTray({
  attachments,
  uploading,
  onRemove,
}: {
  attachments: AttachmentDto[]
  uploading: number
  onRemove: (id: string) => void
}) {
  if (attachments.length === 0 && uploading === 0) return null

  return (
    <div className="flex flex-wrap items-center gap-2 px-1 pb-1.5">
      {attachments.map((attachment) => (
        <div
          key={attachment.id}
          className={cx(
            'group/att relative flex items-center gap-2 rounded-md border border-line',
            'bg-surface-high py-1 pr-1 pl-2 text-xs',
          )}
        >
          {attachment.inlineImage ? (
            <img
              src={`/api/attachments/${attachment.id}`}
              alt={attachment.filename}
              className="size-8 shrink-0 rounded object-cover"
            />
          ) : (
            <FileText size={14} className="shrink-0 text-ink-faint" />
          )}

          <span className="min-w-0">
            <span className="block max-w-40 truncate text-ink">{attachment.filename}</span>
            <span className="block text-[0.6875rem] text-ink-faint">
              {formatBytes(attachment.sizeBytes)}
            </span>
          </span>

          <IconButton
            label={`Retirer ${attachment.filename}`}
            size="sm"
            onClick={() => onRemove(attachment.id)}
          >
            <X size={13} />
          </IconButton>
        </div>
      ))}

      {uploading > 0 ? (
        <span className="flex items-center gap-1.5 rounded-md border border-line bg-surface-high px-2 py-2 text-xs text-ink-faint">
          <Loader size={13} className="animate-spin" />
          {uploading} en cours
        </span>
      ) : null}
    </div>
  )
}
