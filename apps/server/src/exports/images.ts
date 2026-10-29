import { readFile, stat } from 'node:fs/promises'
import { eq, and, sql } from 'drizzle-orm'
import { attachments, events, type Db } from '@sillage/db'
import { EXPORT_MAX_BYTES } from '@sillage/protocol'
import type { EventLog } from '../events/event-log.js'
import { badRequest } from '../http/errors.js'
import { conversationWorkspace } from '../workspace.js'
import { workspaceImagePath } from '../workspace-images.js'
import type { ExportImage } from './source.js'

/** Sniff raster bytes instead of trusting extensions, URLs or agent-provided MIME types. */
function rasterType(buffer: Buffer): string | null {
  if (buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png'
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg'
  if (/^GIF8[79]a$/.test(buffer.toString('ascii', 0, 6))) return 'image/gif'
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (buffer.toString('ascii', 4, 8) === 'ftyp' && /^(avif|avis)$/.test(buffer.toString('ascii', 8, 12))) return 'image/avif'
  return null
}

export async function freezeImage(db: Db, log: EventLog, conversationId: string, userId: string, image: ExportImage): Promise<string> {
  if (image.data) return image.data
  if (!image.available) throw badRequest('export_image_missing', 'Image unavailable.')
  let source = image.source, buffer: Buffer
  const event = /^\/api\/conversations\/([^/]+)\/events\/(\d+)\/images\/(\d+)$/.exec(source)
  if (event) {
    if (event[1] !== conversationId) throw badRequest('export_image_missing', 'Image unavailable.')
    const size = db.select({ bytes: sql<number>`octet_length(${events.payload} -> ${'$.blocks[' + Number(event[3]) + '].url'})` })
      .from(events).where(and(eq(events.conversationId, conversationId), eq(events.seq, Number(event[2])))).get()?.bytes ?? 0
    if (size > EXPORT_MAX_BYTES) throw badRequest('export_too_large', 'Export is too large.')
    source = log.eventImage(conversationId, Number(event[2]), Number(event[3])) ?? ''
  }
  if (/^data:image\/(?:png|jpeg|webp|gif|avif);base64,/i.test(source)) {
    if (source.length > EXPORT_MAX_BYTES) throw badRequest('export_too_large', 'Export is too large.')
    buffer = Buffer.from(source.slice(source.indexOf(',') + 1), 'base64')
  } else {
    let file: string | undefined
    const attachment = /^\/api\/attachments\/([^/?#]+)$/.exec(source)
    if (attachment) {
      file = db.select().from(attachments).where(and(eq(attachments.id, attachment[1]!), eq(attachments.userId, userId),
        eq(attachments.conversationId, conversationId))).get()?.storagePath
    } else {
      // Only references in the captured conversation may reach this resolver. No HTTP fetches.
      if (/^(?:[a-z]+:|\/\/)/i.test(source) && !/^[a-z]:[\\/]/i.test(source)) throw badRequest('export_image_missing', 'Image unavailable.')
      if (source.startsWith('/api/')) {
        const url = new URL(source, 'https://invalid.example')
        if (url.pathname !== '/api/conversations/' + conversationId + '/file/raw') throw badRequest('export_image_missing', 'Image unavailable.')
        source = url.searchParams.get('path') ?? ''
      }
      try {
        file = await workspaceImagePath(db, conversationWorkspace(db, conversationId, userId), conversationId, userId, decodeURI(source))
      } catch { throw badRequest('export_image_missing', 'Image unavailable.') }
    }
    const info = file && await stat(file).catch(() => null)
    if (!file || !info || !info.isFile()) throw badRequest('export_image_missing', 'Image unavailable.')
    if (info.size > EXPORT_MAX_BYTES / 2) throw badRequest('export_too_large', 'Export is too large.')
    buffer = await readFile(file).catch(() => { throw badRequest('export_image_missing', 'Image unavailable.') })
  }
  const mime = rasterType(buffer)
  if (!mime) throw badRequest('export_image_missing', 'Image unavailable.')
  image.data = 'data:' + mime + ';base64,' + buffer.toString('base64')
  return image.data
}
