import { MAX_ATTACHMENT_BYTES, type AttachmentDto } from '@sillage/protocol'
import { ApiRequestError, api } from './api'

/**
 * Téléverse un fichier et retourne sa fiche.
 *
 * Passe par `fetch` directement plutôt que par le client JSON : un envoi multipart
 * doit laisser le navigateur composer lui-même son en-tête `content-type`, frontière
 * comprise.
 */
export async function uploadAttachment(file: File): Promise<AttachmentDto> {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new ApiRequestError(
      413,
      'file_too_large',
      `« ${file.name} » dépasse ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)} Mo.`,
    )
  }

  const body = new FormData()
  body.append('file', file, file.name)

  const response = await fetch('/api/attachments', {
    method: 'POST',
    credentials: 'same-origin',
    body,
  })

  const text = await response.text()
  const parsed: unknown = text ? JSON.parse(text) : null

  if (!response.ok) {
    const payload = parsed as { error?: { code: string; message: string } } | null
    throw new ApiRequestError(
      response.status,
      payload?.error?.code ?? 'upload_failed',
      payload?.error?.message ?? `Envoi de « ${file.name} » impossible.`,
    )
  }
  return parsed as AttachmentDto
}

/** Retire une pièce jointe qui n'a pas encore été envoyée. */
export function discardAttachment(id: string): Promise<void> {
  return api.delete<void>(`/api/attachments/${id}`)
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} ko`
  return `${(bytes / 1024 / 1024).toFixed(1)} Mo`
}
