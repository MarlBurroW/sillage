import type { FastifyInstance } from 'fastify'
import { PREVIEW_HOST_PREFIX, createPreviewShareBodySchema, openPreviewBodySchema, type PreviewCheckDto, type PreviewListDto, type PreviewOpenDto, type PreviewShareDto, type PreviewShareListDto } from '@sillage/protocol'
import { previewShares } from '@sillage/db'
import { desc, eq } from 'drizzle-orm'
import type { AppContext } from '../http/context.js'
import { HttpError } from '../http/errors.js'
import { requireAdmin, requireUser } from '../http/require-user.js'
import { INSTANCE_PROFILE } from '../instance/profile.js'
import { previewTargets } from './targets.js'
import { HEALTH_PATH, type PreviewService, type PreviewShareRow } from './service.js'

export function registerPreviewRoutes(app: FastifyInstance, ctx: AppContext, previews: PreviewService | null): void {
  const desktop = INSTANCE_PROFILE === 'desktop'

  const targets = (userId: string, isAdmin: boolean) => previewTargets(ctx, [ctx.config.server.port, ...(previews ? [previews.listenerPort] : [])], userId, isAdmin)

  app.get('/api/previews', async (request): Promise<PreviewListDto> => {
    const user = requireUser(request)
    const domain = previews?.domain() ?? ''
    return {
      mode: desktop ? 'direct' : domain ? 'proxy' : 'unconfigured',
      domain,
      listenerPort: previews?.listenerPort ?? null,
      targets: (await targets(user.id, user.isAdmin)).map((target) => ({
        ...target,
        address: desktop ? `http://127.0.0.1:${target.port}/` : domain && previews ? previews.address(user.id, target.port, request.protocol === 'https') : null,
      })),
    }
  })

  app.post('/api/previews', async (request): Promise<PreviewOpenDto> => {
    const user = requireUser(request)
    const { port } = openPreviewBodySchema.parse(request.body)
    // Desktop's single account owns the machine, and discovery is Linux-only: any local port goes,
    // straight to loopback, which is already another origin than Sillage.
    if (desktop) {
      const address = `http://127.0.0.1:${port}/`
      return { url: address, address }
    }
    if (!previews?.domain()) throw new HttpError(409, 'previews_unconfigured', 'An administrator must set a preview domain first.')
    // Only ports this account sees in Services: never Sillage itself, another account's private
    // project, or whatever else listens on the machine.
    if (!(await targets(user.id, user.isAdmin)).some((target) => target.port === port)) {
      throw new HttpError(404, 'preview_target_unknown', 'Nothing of yours listens on this port.')
    }
    return previews.open(user.id, port, request.protocol === 'https')
  })

  const shareDto = (row: PreviewShareRow, secure: boolean): PreviewShareDto => ({
    id: row.id, url: previews!.shareUrl(row.id, secure), port: row.port, label: row.label, projectId: row.projectId,
    createdAt: row.createdAt, expiresAt: row.expiresAt, revokedAt: row.revokedAt,
  })

  /** Public demo links are the account's own: each person lists and revokes theirs. */
  app.get('/api/previews/shares', async (request): Promise<PreviewShareListDto> => {
    const user = requireUser(request)
    if (!previews) return { shares: [] }
    // Expired and revoked links stay listed a week, so a link that stopped working is explained.
    const since = Date.now() - 7 * 24 * 3_600_000
    const rows = ctx.db.select().from(previewShares).where(eq(previewShares.userId, user.id)).orderBy(desc(previewShares.createdAt)).all()
      .filter((row) => (row.revokedAt ?? row.expiresAt) > since)
    return { shares: rows.map((row) => shareDto(row, request.protocol === 'https')) }
  })

  app.post('/api/previews/shares', async (request, reply): Promise<PreviewShareDto> => {
    const user = requireUser(request)
    const { port, hours } = createPreviewShareBodySchema.parse(request.body)
    if (!previews) throw new HttpError(409, 'preview_shares_unavailable', 'Public demo links need Sillage Server.')
    if (!previews.domain()) throw new HttpError(409, 'previews_unconfigured', 'An administrator must set a preview domain first.')
    const target = (await targets(user.id, user.isAdmin)).find((entry) => entry.port === port)
    if (!target) throw new HttpError(404, 'preview_target_unknown', 'Nothing of yours listens on this port.')
    const row = previews.createShare({ userId: user.id, projectId: target.projectId, port, label: target.title ?? target.label, hours })
    reply.status(201)
    return shareDto(row, request.protocol === 'https')
  })

  app.delete<{ Params: { id: string } }>('/api/previews/shares/:id', async (request, reply) => {
    const user = requireUser(request)
    const row = ctx.db.select().from(previewShares).where(eq(previewShares.id, request.params.id)).get()
    if (!row || row.userId !== user.id || !previews) throw new HttpError(404, 'preview_share_not_found', 'Demo link not found.')
    previews.revokeShare(row.id)
    return reply.status(204).send()
  })

  /**
   * Routing check for the settings page, admin only: requests a preview host through the public
   * address, as a browser would, and names the first link that fails (DNS, TLS, proxy rule).
   */
  app.post('/api/previews/check', async (request): Promise<PreviewCheckDto> => {
    requireAdmin(request)
    if (!previews) return { status: 'unconfigured', url: null, detail: 'Desktop opens previews directly.' }
    const domain = previews.domain()
    if (!domain) return { status: 'unconfigured', url: null, detail: null }
    if (!previews.listening) return { status: 'listener_down', url: null, detail: `port ${previews.listenerPort}` }
    // The same scheme browsers will use; a fixed id matching the `pv-<hex>` pattern proxies route.
    const url = `${request.protocol === 'https' || !isLocalRequest(request.hostname) ? 'https' : 'http'}://${PREVIEW_HOST_PREFIX}c4ec4ec4ec4e.${domain}${HEALTH_PATH}`
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: 'manual', headers: { 'cache-control': 'no-cache' } })
      const body = await response.text()
      if (response.ok && body.includes(previews.instanceNonce)) return { status: 'ok', url, detail: null }
      if ([502, 503, 504].includes(response.status)) return { status: 'upstream', url, detail: `HTTP ${response.status}` }
      return { status: 'not_routed', url, detail: `HTTP ${response.status}` }
    } catch (err) {
      const cause = (err as { cause?: { code?: string; message?: string } }).cause
      const code = cause?.code ?? (err instanceof Error ? err.name : String(err))
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { status: 'dns', url, detail: code }
      if (/CERT|TLS|SSL|ALTNAME|SELF_SIGNED/i.test(`${code} ${cause?.message ?? ''}`)) return { status: 'tls', url, detail: code }
      return { status: 'unreachable', url, detail: code }
    }
  })
}

/** A request from the machine itself or a private test name, where plain http is expected. */
function isLocalRequest(hostname: string): boolean {
  return /^(?:localhost|127\.|\[?::1\]?)/.test(hostname) || hostname.endsWith('.test')
}
