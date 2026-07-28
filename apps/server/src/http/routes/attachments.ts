import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { MAX_ATTACHMENT_BYTES, type AttachmentDto } from '@sillage/protocol'
import type { AttachmentStore } from '../../attachments/store.js'
import { badRequest, forbidden, notFound } from '../errors.js'
import { requireUser } from '../require-user.js'

/** Types affichables directement par le navigateur, servis tels quels. */
const INLINE_DISPOSITION = /^image\/|^text\/plain$|^application\/pdf$/

export function registerAttachmentRoutes(app: FastifyInstance, store: AttachmentStore): void {
  app.post('/api/attachments', async (request, reply) => {
    const user = requireUser(request)

    const file = await request.file({ limits: { fileSize: MAX_ATTACHMENT_BYTES } })
    if (!file) throw badRequest('no_file', 'No file received.')

    const content = await file.toBuffer().catch(() => null)
    // `toBuffer` échoue quand la limite est franchie : la taille est donc contrôlée
    // pendant la lecture, sans jamais charger un fichier démesuré en mémoire.
    if (!content) {
      throw badRequest('file_too_large', 'File is too large (maximum {maxMb} MB).', {
        maxMb: Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024),
      })
    }
    if (content.byteLength === 0) throw badRequest('empty_file', 'File is empty.')

    // `basename` neutralise un nom qui contiendrait un chemin : il est affiché et
    // transmis à l'agent, il ne doit désigner aucun répertoire.
    const dto: AttachmentDto = await store.save({
      userId: user.id,
      filename: basename(file.filename).slice(0, 200) || 'fichier',
      content,
    })
    return reply.status(201).send(dto)
  })

  app.get('/api/attachments/:id', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }

    const row = store.get(id)
    if (!row) throw notFound('attachment_not_found', 'Attachment not found.')
    // Le partage se fait au niveau du projet, pas du fichier téléversé : seul son
    // propriétaire le relit.
    if (row.userId !== user.id) throw forbidden('attachment_forbidden', 'This attachment is not yours.')

    const info = await stat(row.storagePath).catch(() => null)
    if (!info) throw notFound('attachment_file_missing', 'The file is gone from disk.')

    const disposition = INLINE_DISPOSITION.test(row.mimeType) ? 'inline' : 'attachment'
    return reply
      .type(row.mimeType)
      .header('content-length', info.size)
      .header(
        'content-disposition',
        `${disposition}; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
      )
      .header('cache-control', 'private, max-age=31536000, immutable')
      .send(createReadStream(row.storagePath))
  })

  app.delete('/api/attachments/:id', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }

    const row = store.get(id)
    if (!row) return reply.status(204).send()
    if (row.userId !== user.id) throw forbidden('attachment_forbidden', 'This attachment is not yours.')
    // Retirer une pièce jointe déjà envoyée réécrirait l'historique du fil, que le
    // journal doit pouvoir rejouer à l'identique (invariant I2).
    if (row.conversationId) {
      throw badRequest('already_sent', 'This attachment is already part of the conversation.')
    }

    await store.remove(id)
    return reply.status(204).send()
  })
}
