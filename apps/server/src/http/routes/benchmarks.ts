import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { BENCHMARK_PREVIEW_PREFIX, BENCHMARK_SHARE_PREFIX, benchmarkShareOptionsSchema, publishBenchmarkShareBodySchema, createBenchmarkBodySchema, updateBenchmarkConcurrencyBodySchema, rateBenchmarkRunBodySchema, type BenchmarkDto } from '@sillage/protocol'
import { PREVIEW_POLICY, previewType } from '../../benchmarks/deliverables.js'
import type { BenchmarkRunner } from '../../benchmarks/runner.js'
import { BenchmarkShares } from '../../benchmarks/share.js'
import { SHARE_PAGE_CSP, renderShareUnavailable } from '../../benchmarks/share-page.js'
import { streamArchive } from '../../workspace-archive.js'
import { attachmentHeader } from '../attachment-header.js'
import { resolveRealInside } from '../../workspace.js'
import type { AppContext } from '../context.js'
import { badRequest, notFound } from '../errors.js'
import { parseRange } from '../range.js'
import { requireUser } from '../require-user.js'

/** Personal benchmarks: each account sees and controls only its own, like its discussions. */
export function registerBenchmarkRoutes(app: FastifyInstance, ctx: AppContext, runner: BenchmarkRunner): void {
  const shares = new BenchmarkShares(ctx, runner)

  app.get('/api/benchmarks', async (request): Promise<BenchmarkDto[]> => {
    const user = requireUser(request)
    return runner.list(user.id)
  })

  app.post('/api/benchmarks', async (request, reply) => {
    const user = requireUser(request)
    const body = createBenchmarkBodySchema.parse(request.body)
    const row = await runner.create(user.id, body)
    return reply.status(201).send(runner.dto(row))
  })

  app.get('/api/benchmarks/:id', async (request): Promise<BenchmarkDto> => {
    const user = requireUser(request)
    const row = runner.load((request.params as { id: string }).id, user.id)
    return runner.dto(row)
  })

  app.put('/api/benchmarks/:id/concurrency', async (request): Promise<BenchmarkDto> => {
    const user = requireUser(request)
    const row = runner.load((request.params as { id: string }).id, user.id)
    const body = updateBenchmarkConcurrencyBodySchema.parse(request.body)
    runner.setConcurrency(row.id, body.concurrency)
    return runner.dto(runner.load(row.id, user.id))
  })

  app.post('/api/benchmarks/:id/cancel', async (request): Promise<BenchmarkDto> => {
    const user = requireUser(request)
    const row = runner.load((request.params as { id: string }).id, user.id)
    await runner.cancel(row.id)
    return runner.dto(runner.load(row.id, user.id))
  })

  app.post('/api/benchmarks/:id/rerun', async (request, reply) => {
    const user = requireUser(request)
    const row = await runner.rerun((request.params as { id: string }).id, user.id)
    return reply.status(201).send(runner.dto(row))
  })

  app.put('/api/benchmarks/:id/runs/:runId/rating', async (request): Promise<BenchmarkDto> => {
    const user = requireUser(request)
    const { id, runId } = request.params as { id: string; runId: string }
    const row = runner.load(id, user.id)
    const body = rateBenchmarkRunBodySchema.parse(request.body)
    runner.rate(row.id, runId, body.rating, body.note)
    return runner.dto(row)
  })

  app.delete('/api/benchmarks/:id', async (request, reply) => {
    const user = requireUser(request)
    const row = runner.load((request.params as { id: string }).id, user.id)
    await shares.removeFor(row.id)
    await runner.delete(row.id)
    return reply.status(204).send()
  })

  // --- Sharing -------------------------------------------------------------------

  app.get('/api/benchmarks/:id/share', async (request, reply) => {
    const user = requireUser(request)
    reply.header('cache-control', 'no-store')
    return shares.state((request.params as { id: string }).id, user.id)
  })

  app.post('/api/benchmarks/:id/share', async (request, reply) => {
    const user = requireUser(request)
    const { expiresAt, ...options } = publishBenchmarkShareBodySchema.parse(request.body)
    return reply.status(201).send(await shares.publish((request.params as { id: string }).id, user.id, options, expiresAt))
  })

  app.delete('/api/benchmarks/:id/share/:shareId', async (request, reply) => {
    const user = requireUser(request)
    const { id, shareId } = request.params as { id: string; shareId: string }
    await shares.revoke(id, shareId, user.id)
    return reply.status(204).send()
  })

  /** A GET so the browser downloads it as a file; the options travel as one JSON parameter. */
  app.get('/api/benchmarks/:id/archive', async (request, reply) => {
    const user = requireUser(request)
    const { options } = z.object({ options: z.string().max(8000) }).parse(request.query)
    let parsed: unknown
    try {
      parsed = JSON.parse(options)
    } catch {
      throw badRequest('invalid_options', 'Invalid options.')
    }
    const archive = await shares.archive((request.params as { id: string }).id, user.id, benchmarkShareOptionsSchema.parse(parsed))
    const stream = streamArchive(archive.items)
    stream.once('close', () => void archive.dispose())
    return reply
      .header('content-type', 'application/zip')
      .header('content-disposition', attachmentHeader(archive.filename))
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'no-store')
      .send(stream)
  })

  // Without the trailing slash the page's relative links would resolve one level too high.
  app.get(`${BENCHMARK_SHARE_PREFIX}:token`, { logLevel: 'silent' }, (request, reply) => {
    const { token } = request.params as { token: string }
    return reply.redirect(`${BENCHMARK_SHARE_PREFIX}${encodeURIComponent(token)}/`, 308)
  })

  /**
   * A published benchmark: the page at the root, the copied productions under `runs/`. The page
   * only runs its own pinned script; the productions get the same sandbox as the owner's previews.
   */
  app.get(`${BENCHMARK_SHARE_PREFIX}:token/*`, { logLevel: 'silent' }, async (request, reply) => {
    const { token, '*': rest } = request.params as { token: string; '*': string }
    reply
      .header('cache-control', 'private, no-store')
      .header('referrer-policy', 'no-referrer')
      .header('x-content-type-options', 'nosniff')
      .header('x-robots-tag', 'noindex, nofollow, noarchive')
    const root = shares.publicRoot(token)
    if (!root || !(await stat(join(root, 'index.html')).catch(() => null))?.isFile()) {
      const locale = /^fr(?:[-,;]|$)/i.test(request.headers['accept-language'] ?? '') ? 'fr' : 'en'
      return reply.code(404).header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'").type('text/html; charset=utf-8').send(renderShareUnavailable(locale))
    }
    if (!rest || rest === 'index.html') {
      return reply.header('content-security-policy', SHARE_PAGE_CSP).type('text/html; charset=utf-8').send(createReadStream(join(root, 'index.html')))
    }
    return sendSandboxed(request, reply, root, rest)
  })

  /**
   * What a run produced, served for side-by-side previews: a page with its own scripts and
   * styles, images, media. Public behind the run's token because the sandbox policy gives the
   * page an opaque origin whose subresource requests carry no session cookie. The policy also
   * means a page cannot use the viewer's session, even opened alone in a tab.
   */
  app.get(`${BENCHMARK_PREVIEW_PREFIX}:token/*`, async (request, reply) => {
    const { token, '*': rest } = request.params as { token: string; '*': string }
    const root = runner.previewRoot(token)
    if (!root) throw notFound('preview_not_found', 'Preview not found.')
    return sendSandboxed(request, reply, root, rest)
  })
}

/**
 * Sends one file of an agent's production under the sandbox policy. Shared by the owner's
 * previews and the public snapshots: both serve untrusted pages from Sillage's own host.
 */
async function sendSandboxed(request: FastifyRequest, reply: FastifyReply, root: string, rest: string): Promise<FastifyReply> {
  const relative = decodeURIComponent(rest || '')
  let absolute = await resolveRealInside(root, relative || '.')
  let info = await stat(absolute).catch(() => null)
  // A folder serves its index, as a static host would: links to `./` keep working.
  if (info?.isDirectory()) {
    absolute = await resolveRealInside(root, join(relative, 'index.html'))
    info = await stat(absolute).catch(() => null)
  }
  if (!info?.isFile()) throw notFound('file_not_found', 'File not found.')
  // Open the checked real path, not the one a symlink could swap afterwards.
  const real = await realpath(absolute)
  const download = (request.query as { download?: string }).download === '1'

  reply
    .header('content-type', previewType(real))
    .header('content-security-policy', PREVIEW_POLICY)
    .header('x-content-type-options', 'nosniff')
    .header('referrer-policy', 'no-referrer')
    .header('cache-control', 'no-store')
    .header('accept-ranges', 'bytes')
    .header('content-disposition', `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(basename(real))}`)

  const range = parseRange(request.headers.range, info.size)
  if (range === 'unsatisfiable') return reply.code(416).header('content-range', `bytes */${info.size}`).send()
  if (range) {
    return reply
      .code(206)
      .header('content-range', `bytes ${range.start}-${range.end}/${info.size}`)
      .header('content-length', range.end - range.start + 1)
      .send(createReadStream(real, { start: range.start, end: range.end }))
  }
  return reply.header('content-length', info.size).send(createReadStream(real))
}
