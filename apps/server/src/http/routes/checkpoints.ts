import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { conversations } from '@sillage/db'
import {
  checkpointFileDiffQuerySchema,
  checkpointKeySchema,
  type CheckpointRestoreDto,
  type GitFileDiffDto,
} from '@sillage/protocol'
import { CheckpointError, readCheckpointFileDiff } from '../../checkpoints.js'
import type { SessionManager } from '../../sessions/session-manager.js'
import { conversationWorkspace } from '../../workspace.js'
import type { AppContext } from '../context.js'
import { HttpError, badRequest, notFound } from '../errors.js'
import { requireUser } from '../require-user.js'

/**
 * Les points de reprise d'un tour : lire le diff d'un fichier entre les deux captures,
 * et ramener le workspace à l'état d'avant.
 *
 * La liste des fichiers, elle, ne passe pas par ici : l'événement `checkpoint.completed`
 * du journal la porte déjà, et c'est de lui que le fil et le panneau la tiennent.
 * Par conversation seulement, un point de reprise n'existant que par un tour.
 */
export function registerCheckpointRoutes(app: FastifyInstance, ctx: AppContext, sessions: SessionManager): void {
  const parseKey = (key: string): string => {
    const parsed = checkpointKeySchema.safeParse(key)
    if (!parsed.success) throw badRequest('bad_checkpoint', 'This is not a checkpoint key.')
    return parsed.data
  }

  const translate = (err: unknown): never => {
    if (err instanceof CheckpointError) {
      if (err.code === 'checkpoint_missing') throw notFound(err.code, err.detail)
      throw new HttpError(400, err.code, err.detail)
    }
    throw err
  }

  app.get('/api/conversations/:id/checkpoints/:key/file-diff', async (request): Promise<GitFileDiffDto> => {
    const user = requireUser(request)
    const { id, key } = request.params as { id: string; key: string }
    const cwd = conversationWorkspace(ctx.db, id, user.id)
    const query = checkpointFileDiffQuerySchema.parse(request.query)

    try {
      return await readCheckpointFileDiff(cwd, id, parseKey(key), query.path, query.oldPath ?? null)
    } catch (err) {
      return translate(err)
    }
  })

  /**
   * Remet le workspace tel qu'il était avant le tour. Réservé au propriétaire : c'est
   * son dépôt qu'on réécrit, et son fil qui en garde la trace.
   */
  app.post('/api/conversations/:id/checkpoints/:key/restore', async (request): Promise<CheckpointRestoreDto> => {
    const user = requireUser(request)
    const { id, key } = request.params as { id: string; key: string }
    conversationWorkspace(ctx.db, id, user.id)
    const conversation = ctx.db
      .select({ userId: conversations.userId })
      .from(conversations)
      .where(eq(conversations.id, id))
      .get()
    if (!conversation || conversation.userId !== user.id) {
      throw new HttpError(403, 'conversation_write_forbidden', 'Only the conversation owner can restore its workspace.')
    }

    try {
      return await sessions.restoreCheckpoint(id, parseKey(key))
    } catch (err) {
      return translate(err)
    }
  })
}
