import { MAX_ATTACHMENT_BYTES, type AttachmentDto } from '@sillage/protocol'
import { ApiRequestError, api } from './api'
import { translate } from './i18n'

/**
 * Upload a file and return metadata. Use `fetch` directly rather than the JSON client: multipart
 * uploads must let the browser build the content-type header including its boundary.
 */
export async function uploadAttachment(file: File, endpoint = '/api/attachments'): Promise<AttachmentDto> {
  if (file.size > MAX_ATTACHMENT_BYTES) {
    throw new ApiRequestError(
      413,
      'file_too_large',
      translate('attachments.tooLarge', {
        name: file.name,
        max: Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024),
      }),
    )
  }

  const body = new FormData()
  body.append('file', file, file.name)

  const response = await fetch(endpoint, {
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

/** Remove an attachment not yet sent. */
export function discardAttachment(id: string): Promise<void> {
  return api.delete<void>(`/api/attachments/${id}`)
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} ko`
  // Gigabytes serve explorer uploads rather than attachments capped at 20 MB: a 4300.5 MB label is unreadable.
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} Mo`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} Go`
}
