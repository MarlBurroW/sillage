import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { z } from 'zod'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { exportOptionsSchema, exportPublishSchema, exportRenderSchema, exportSelectionSchema } from '@sillage/protocol'
import type { AppContext } from '../context.js'
import type { EventLog } from '../../events/event-log.js'
import { ConversationExports } from '../../exports/service.js'
import { EXPORT_CSP, EXPORT_SANDBOX, renderUnavailable } from '../../exports/render.js'
import { requireUser } from '../require-user.js'
import { attachmentHeader } from '../attachment-header.js'

function headers(reply: FastifyReply): FastifyReply {
  return reply.header('cache-control', 'private, no-store').header('referrer-policy', 'no-referrer')
    .header('x-content-type-options', 'nosniff').header('x-robots-tag', 'noindex, nofollow, noarchive')
    .header('content-security-policy', EXPORT_CSP + '; ' + EXPORT_SANDBOX)
}

export function registerExportRoutes(app: FastifyInstance, ctx: AppContext, log: EventLog): ConversationExports {
  const exports = new ConversationExports(ctx, log)
  app.addHook('onClose', () => exports.stop())
  const idOf = (params: unknown) => z.object({ id: z.string().min(1).max(200) }).parse(params).id
  const revision = (query: unknown) => z.object({ revision: z.coerce.number().int().positive() }).parse(query).revision

  app.post('/api/conversations/:id/exports', (request, reply) => {
    const user = requireUser(request)
    const { locale } = z.object({ locale: z.enum(['en', 'fr']) }).parse(request.body)
    return reply.code(202).header('cache-control', 'no-store').send(exports.create(idOf(request.params), user.id, locale))
  })
  app.get('/api/exports/:id', (request, reply) => {
    reply.header('cache-control', 'no-store')
    return exports.get(idOf(request.params), requireUser(request).id)
  })
  app.get('/api/exports/:id/review', (request, reply) => {
    reply.header('cache-control', 'no-store')
    return exports.get(idOf(request.params), requireUser(request).id, true)
  })
  app.get('/api/exports/:id/items', (request, reply) => {
    const { offset, query } = z.object({ offset: z.coerce.number().int().nonnegative().default(0), query: z.string().max(500).default('') }).parse(request.query)
    reply.header('cache-control', 'no-store')
    return exports.items(idOf(request.params), requireUser(request).id, offset, query)
  })
  app.get('/api/exports/:id/images/:image', async (request, reply) => {
    const { id, image } = z.object({ id: z.string(), image: z.string().max(200) }).parse(request.params)
    const url = await exports.image(id, requireUser(request).id, image)
    const comma = url.indexOf(',')
    return headers(reply).type(url.slice(5, url.indexOf(';'))).send(Buffer.from(url.slice(comma + 1), 'base64'))
  })
  app.post('/api/exports/:id/selection', (request, reply) => {
    reply.header('cache-control', 'no-store')
    return exports.selection(idOf(request.params), requireUser(request).id, exportSelectionSchema.parse(request.body))
  })
  app.post('/api/exports/:id/analyze', (request, reply) =>
    reply.code(202).send(exports.analyze(idOf(request.params), requireUser(request).id, exportOptionsSchema.parse(request.body))))
  app.post('/api/exports/:id/render', (request, reply) =>
    reply.code(202).send(exports.render(idOf(request.params), requireUser(request).id, exportRenderSchema.parse(request.body))))
  app.get('/api/exports/:id/html', (request, reply) => {
    const artifact = exports.artifact(idOf(request.params), requireUser(request).id, revision(request.query))
    headers(reply).type('text/html; charset=utf-8')
    if ((request.query as { download?: string }).download === '1') {
      reply.header('content-disposition', attachmentHeader(artifact.title.replace(/[/\\]/g, '-') + '.html'))
    }
    return reply.send(createReadStream(artifact.file))
  })
  app.post('/api/exports/:id/publish', async (request, reply) => {
    const body = exportPublishSchema.parse(request.body)
    return reply.code(201).send(await exports.publish(idOf(request.params), requireUser(request).id, body.revision, body.expiresAt))
  })
  app.delete('/api/exports/:id', async (request, reply) => {
    await exports.cancel(idOf(request.params), requireUser(request).id)
    return reply.code(204).send()
  })
  app.get('/api/conversations/:id/shares', (request, reply) => {
    reply.header('cache-control', 'no-store')
    return exports.list(idOf(request.params), requireUser(request).id)
  })
  app.delete('/api/conversation-shares/:id', async (request, reply) => {
    await exports.revoke(idOf(request.params), requireUser(request).id)
    return reply.code(204).send()
  })
  app.get('/s/:token', { logLevel: 'silent' }, async (request, reply) => {
    headers(reply).header('content-security-policy', EXPORT_CSP + '; ' + EXPORT_SANDBOX + "; frame-ancestors 'none'")
    const file = exports.publicArtifact((request.params as { token: string }).token)
    if (!file || !(await stat(file).catch(() => null))?.isFile()) {
      const locale = /^fr(?:[-,;]|$)/i.test(request.headers['accept-language'] ?? '') ? 'fr' : 'en'
      return reply.code(404).type('text/html; charset=utf-8').send(renderUnavailable(locale))
    }
    return reply.type('text/html; charset=utf-8').send(createReadStream(file))
  })
  return exports
}
