import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { BENCHMARK_PREVIEW_PREFIX, createBenchmarkBodySchema, rateBenchmarkRunBodySchema, type BenchmarkDto } from '@sillage/protocol'
import { PREVIEW_POLICY, previewType } from '../../benchmarks/deliverables.js'
import { benchmarksToDto, type BenchmarkRunner } from '../../benchmarks/runner.js'
import { resolveRealInside } from '../../workspace.js'
import type { AppContext } from '../context.js'
import { notFound } from '../errors.js'
import { parseRange } from '../range.js'
import { requireUser } from '../require-user.js'

/** Personal benchmarks: each account sees and controls only its own, like its discussions. */
export function registerBenchmarkRoutes(app: FastifyInstance, ctx: AppContext, runner: BenchmarkRunner): void {
  app.get('/api/benchmarks', async (request): Promise<BenchmarkDto[]> => {
    const user = requireUser(request)
    return runner.list(user.id)
  })

  app.post('/api/benchmarks', async (request, reply) => {
    const user = requireUser(request)
    const body = createBenchmarkBodySchema.parse(request.body)
    const row = await runner.create(user.id, body)
    return reply.status(201).send(benchmarksToDto(ctx.db, [row])[0])
  })

  app.get('/api/benchmarks/:id', async (request): Promise<BenchmarkDto> => {
    const user = requireUser(request)
    const row = runner.load((request.params as { id: string }).id, user.id)
    return benchmarksToDto(ctx.db, [row])[0]!
  })

  app.post('/api/benchmarks/:id/cancel', async (request): Promise<BenchmarkDto> => {
    const user = requireUser(request)
    const row = runner.load((request.params as { id: string }).id, user.id)
    await runner.cancel(row.id)
    return benchmarksToDto(ctx.db, [runner.load(row.id, user.id)])[0]!
  })

  app.post('/api/benchmarks/:id/rerun', async (request, reply) => {
    const user = requireUser(request)
    const row = await runner.rerun((request.params as { id: string }).id, user.id)
    return reply.status(201).send(benchmarksToDto(ctx.db, [row])[0])
  })

  app.put('/api/benchmarks/:id/runs/:runId/rating', async (request): Promise<BenchmarkDto> => {
    const user = requireUser(request)
    const { id, runId } = request.params as { id: string; runId: string }
    const row = runner.load(id, user.id)
    const body = rateBenchmarkRunBodySchema.parse(request.body)
    runner.rate(row.id, runId, body.rating, body.note)
    return benchmarksToDto(ctx.db, [row])[0]!
  })

  app.delete('/api/benchmarks/:id', async (request, reply) => {
    const user = requireUser(request)
    const row = runner.load((request.params as { id: string }).id, user.id)
    await runner.delete(row.id)
    return reply.status(204).send()
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
  })
}
