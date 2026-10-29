import { randomBytes, randomUUID } from 'node:crypto'
import { copyFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { and, desc, eq, isNull, or, gt, sql } from 'drizzle-orm'
import { conversationShares, conversations, events } from '@sillage/db'
import {
  EXPORT_MAX_BYTES, EXPORT_TTL_MS, exportOptionsSchema,
  type ExportDraftDto, type ExportFinding, type ExportItemsDto, type ExportOptions, type ExportSelectionOptions,
  type ExportRenderRequest, type ConversationShareDto, type AgentKind,
} from '@sillage/protocol'
import type { AppContext } from '../http/context.js'
import { HttpError, badRequest, forbidden, notFound } from '../http/errors.js'
import { readableConversation } from '../conversations/access.js'
import type { EventLog } from '../events/event-log.js'
import { publicUrlOf } from '../settings/app-settings.js'
import { instanceCapabilities, INSTANCE_PROFILE } from '../instance/profile.js'
import { captureEntries, entryDto, selectDocument, describeSelection, type ExportDocument, type ExportEntry } from './source.js'
import { freezeImage } from './images.js'
import { scanFields, maskFields } from './redaction.js'
import { exportText } from './labels.js'
import { renderExport } from './render.js'

interface Draft {
  id: string; conversationId: string; userId: string; agent: AgentKind
  throughSeq: number; revision: number; status: ExportDraftDto['status']
  progress: number; error: string | null; expiresAt: number; options: ExportOptions
  entries: ExportEntry[]; controller: AbortController
  document?: ExportDocument; findings?: ExportFinding[]
  file?: string; bytes?: number; safeTitle?: string
}

/** Drafts never persist raw conversation copies. Only reviewed artifacts survive publication. */
export class ConversationExports {
  private drafts = new Map<string, Draft>()
  private directory: string
  private timer: ReturnType<typeof setInterval>
  private cleaning = false
  private publishing = new Set<string>()

  constructor(private ctx: AppContext, private log: EventLog, private publicSharing = instanceCapabilities(INSTANCE_PROFILE).publicConversationSharing) {
    this.directory = join(ctx.config.paths.data, 'conversation-exports')
    this.timer = setInterval(() => { void this.cleanup().catch(() => {}) }, 60_000)
    this.timer.unref()
    void this.cleanup().catch(() => {})
  }

  async stop(): Promise<void> {
    clearInterval(this.timer)
    for (const draft of this.drafts.values()) draft.controller.abort()
    this.drafts.clear()
  }

  private owner(conversationId: string, userId: string) {
    const conversation = readableConversation(this.ctx.db, conversationId, userId)
    if (conversation.userId !== userId) throw forbidden('export_owner', 'Only the conversation owner can export it.')
    return conversation
  }

  private root(): string {
    if (!this.publicSharing) return ''
    const value = publicUrlOf(this.ctx.db, this.ctx.config)
    try {
      const url = new URL(value)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return ''
      if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return ''
      return url.href.replace(/\/$/, '')
    } catch { return '' }
  }

  private draft(id: string, userId: string): Draft {
    const draft = this.drafts.get(id)
    if (!draft || draft.userId !== userId || draft.expiresAt <= Date.now()) throw notFound('export_expired', 'Export preparation expired.')
    this.owner(draft.conversationId, userId)
    return draft
  }

  private dto(draft: Draft, review = false): ExportDraftDto {
    return {
      id: draft.id, conversationId: draft.conversationId, agent: draft.agent,
      throughSeq: draft.throughSeq, revision: draft.revision, status: draft.status,
      progress: draft.progress, error: draft.error, expiresAt: draft.expiresAt,
      options: draft.options, total: draft.entries.length, canPublish: !!this.root(), bytes: draft.bytes,
      ...(review && draft.document && draft.findings ? {
        fields: draft.document.fields, findings: draft.findings,
        selectedImages: draft.document.images.map(({ id, label, available }) => ({ id, label, available })),
      } : {}),
    }
  }

  get(id: string, userId: string, review = false): ExportDraftDto { return this.dto(this.draft(id, userId), review) }

  create(conversationId: string, userId: string, locale: 'en' | 'fr'): ExportDraftDto {
    const source = this.owner(conversationId, userId)
    const active = [...this.drafts.values()].filter(draft => draft.expiresAt > Date.now())
    if (active.length >= 8 || active.filter(draft => draft.userId === userId).length >= 2) throw badRequest('export_busy', 'Another export is already active.')
    const draft: Draft = {
      id: randomUUID(), conversationId, userId, agent: source.agent, throughSeq: source.lastSeq,
      revision: 1, status: 'preparing', progress: 0, error: null, expiresAt: Date.now() + EXPORT_TTL_MS,
      options: exportOptionsSchema.parse({ locale, title: source.title || 'Sillage' }), entries: [], controller: new AbortController(),
    }
    this.drafts.set(draft.id, draft)
    this.run(draft, async signal => {
      draft.entries = await captureEntries(this.log, conversationId, draft.throughSeq, locale, signal, p => { draft.progress = p })
      draft.status = 'ready'
    })
    return this.dto(draft)
  }

  private run(draft: Draft, work: (signal: AbortSignal) => Promise<void>): void {
    const controller = draft.controller
    void work(controller.signal).catch(error => {
      if (controller.signal.aborted) return
      draft.status = 'failed'
      draft.error = error instanceof HttpError && error.code.startsWith('export_') ? error.code : 'export_failed'
    })
  }

  items(id: string, userId: string, offset: number, query: string): ExportItemsDto {
    const draft = this.draft(id, userId)
    const needle = query.toLocaleLowerCase()
    const entries = needle ? draft.entries.filter(entry => entry.privateTitle?.toLocaleLowerCase().includes(needle) || entry.fields.some(field => field.text.toLocaleLowerCase().includes(needle))) : draft.entries
    return { items: entries.slice(offset, offset + 80).map(entry => entryDto(entry, draft.options.locale)), total: entries.length,
      next: offset + 80 < entries.length ? offset + 80 : null }
  }

  async image(id: string, userId: string, imageId: string): Promise<string> {
    const draft = this.draft(id, userId)
    const image = draft.entries.flatMap(entry => entry.images).find(image => image.id === imageId)
    if (!image) throw notFound('export_image_missing', 'Image unavailable.')
    const data = await freezeImage(this.ctx.db, this.log, draft.conversationId, userId, image)
    const total = draft.entries.reduce((bytes, entry) => bytes + entry.images.reduce((size, image) => size + (image.data?.length ?? 0), 0), 0)
    if (total > EXPORT_MAX_BYTES) { delete image.data; throw badRequest('export_too_large', 'Export is too large.') }
    return data
  }

  analyze(id: string, userId: string, options: ExportOptions): ExportDraftDto {
    const draft = this.draft(id, userId)
    if (draft.status === 'preparing') throw badRequest('export_busy', 'Export is being prepared.')
    draft.controller.abort()
    draft.controller = new AbortController()
    draft.revision++
    draft.options = options
    draft.status = 'analyzing'
    draft.progress = 0
    draft.error = null
    draft.document = undefined
    draft.findings = undefined
    draft.bytes = undefined
    if (draft.file) { void rm(draft.file, { force: true }).catch(() => {}); draft.file = undefined }
    this.run(draft, async signal => {
      const document = await selectDocument(draft.entries, options, ref => {
        // Check the body before parsing it, including when replay retained only a tiny preview.
        const jsonPath = ref.block === undefined ? '$.' + ref.field : '$.blocks[' + ref.block + '].' + ref.field
        const size = this.ctx.db.select({ bytes: sql<number>`octet_length(${events.payload} -> ${jsonPath})` })
          .from(events).where(and(eq(events.conversationId, draft.conversationId), eq(events.seq, ref.seq))).get()?.bytes ?? 0
        if (size > EXPORT_MAX_BYTES) throw badRequest('export_too_large', 'Export is too large.')
        const found = this.log.eventBody(draft.conversationId, ref.seq, ref.field, ref.block)
        if (!found) throw badRequest('export_invalid', 'Export body unavailable.')
        return found.value
      }, signal)
      let bytes = document.fields.reduce((size, field) => size + Buffer.byteLength(field.text), 0)
      for (const image of document.images) {
        signal.throwIfAborted()
        bytes += (await this.image(id, userId, image.id)).length
        if (bytes > EXPORT_MAX_BYTES) throw badRequest('export_too_large', 'Export is too large.')
      }
      const findings = await scanFields(document.fields, signal, p => { draft.progress = p })
      signal.throwIfAborted()
      draft.document = document
      draft.findings = findings
      draft.status = 'review'
    })
    return this.dto(draft)
  }

  selection(id: string, userId: string, options: ExportSelectionOptions) {
    const draft = this.draft(id, userId)
    return describeSelection(draft.entries, options, draft.options.locale)
  }

  render(id: string, userId: string, request: ExportRenderRequest): ExportDraftDto {
    const draft = this.draft(id, userId)
    if (draft.revision !== request.revision || !draft.document || !draft.findings || !['review', 'complete'].includes(draft.status)) {
      throw badRequest('export_stale', 'Preview changed.')
    }
    if (draft.document.images.some(image => !request.reviewedImages.includes(image.id))) {
      throw badRequest('export_image_review', 'Review selected images.')
    }
    const t = exportText(draft.options.locale)
    const masked = maskFields(draft.document.fields, draft.findings, request, kind => t(('export.page.mask.' + kind) as 'export.page.mask.secret'))
    draft.revision++
    draft.status = 'rendering'
    draft.error = null
    const revision = draft.revision, document = draft.document
    const oldFile = draft.file
    draft.file = undefined
    this.run(draft, async signal => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      signal.throwIfAborted()
      const html = renderExport(document, masked, draft.agent, this.root())
      const file = join(this.directory, 'draft-' + draft.id + '-' + revision + '.html')
      await writeFile(file, html, { mode: 0o600, flag: 'wx' })
      if (signal.aborted || draft.revision !== revision) { await rm(file, { force: true }); return }
      if (oldFile) await rm(oldFile, { force: true })
      draft.file = file
      draft.bytes = Buffer.byteLength(html)
      draft.safeTitle = masked.get('title') ?? 'Sillage'
      draft.status = 'complete'
      draft.progress = 1
    })
    return this.dto(draft)
  }

  artifact(id: string, userId: string, revision: number): { file: string; title: string } {
    const draft = this.draft(id, userId)
    if (draft.status !== 'complete' || draft.revision !== revision || !draft.file) throw badRequest('export_stale', 'Preview changed.')
    return { file: draft.file, title: draft.safeTitle ?? 'Sillage' }
  }

  async publish(id: string, userId: string, revision: number, expiresAt: number | null): Promise<ConversationShareDto> {
    if (!this.root()) throw badRequest('export_publish_unavailable', 'Public sharing unavailable.')
    if (expiresAt !== null && expiresAt <= Date.now()) throw badRequest('export_expiry', 'Expiration must be in the future.')
    const draft = this.draft(id, userId)
    const artifact = this.artifact(id, userId, revision)
    const shareId = randomBytes(24).toString('base64url')
    const file = this.shareFile(shareId)
    this.publishing.add(file)
    try {
      await copyFile(artifact.file, file)
      // Recheck after I/O: a concurrent edit/delete must not publish an obsolete approval.
      this.artifact(id, userId, revision)
      const share = { id: shareId, conversationId: draft.conversationId, userId,
        title: artifact.title, createdAt: Date.now(), expiresAt, revokedAt: null }
      this.ctx.db.insert(conversationShares).values(share).run()
      return { ...share, url: this.root() + '/s/' + shareId }
    } catch (error) { await rm(file, { force: true }); throw error }
    finally { this.publishing.delete(file) }
  }

  list(conversationId: string, userId: string): ConversationShareDto[] {
    this.owner(conversationId, userId)
    return this.ctx.db.select().from(conversationShares).where(eq(conversationShares.conversationId, conversationId))
      .orderBy(desc(conversationShares.createdAt)).all().map(share => ({
        id: share.id, title: share.title, createdAt: share.createdAt, expiresAt: share.expiresAt, revokedAt: share.revokedAt,
        url: this.root() ? this.root() + '/s/' + share.id : null,
      }))
  }

  async revoke(id: string, userId: string): Promise<void> {
    const row = this.ctx.db.select().from(conversationShares).where(and(eq(conversationShares.id, id), eq(conversationShares.userId, userId))).get()
    if (!row) throw notFound('not_found', 'Not found.')
    this.owner(row.conversationId, userId)
    this.ctx.db.update(conversationShares).set({ revokedAt: Date.now() }).where(eq(conversationShares.id, id)).run()
    await rm(this.shareFile(id), { force: true })
  }

  publicArtifact(token: string): string | null {
    if (!this.publicSharing || !/^[a-zA-Z0-9_-]{32}$/.test(token)) return null
    return this.activeShare(token) ? this.shareFile(token) : null
  }

  private activeShare(token: string): boolean {
    const row = this.ctx.db.select({ id: conversationShares.id }).from(conversationShares)
      .where(and(eq(conversationShares.id, token), isNull(conversationShares.revokedAt),
        or(isNull(conversationShares.expiresAt), gt(conversationShares.expiresAt, Date.now())))).get()
    return !!row
  }

  private shareFile(id: string): string { return join(this.directory, 'share-' + id + '.html') }

  async cancel(id: string, userId: string): Promise<void> {
    const draft = this.drafts.get(id)
    if (!draft || draft.userId !== userId) return
    draft.controller.abort()
    this.drafts.delete(id)
    if (draft.file) await rm(draft.file, { force: true })
  }

  async cleanup(): Promise<void> {
    if (this.cleaning) return
    this.cleaning = true
    try {
      for (const draft of this.drafts.values()) {
        if (draft.expiresAt <= Date.now() || !this.ctx.db.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, draft.conversationId)).get()) {
          await this.cancel(draft.id, draft.userId)
        }
      }
      const activeFiles = new Set([...this.drafts.values()].flatMap(draft => draft.file ? [draft.file] : []))
      const files = await readdir(this.directory).catch(() => [])
      for (const name of files) {
        const file = join(this.directory, name)
        if (this.publishing.has(file)) continue
        const share = /^share-([A-Za-z0-9_-]{32})\.html$/.exec(name)
        if (share) {
          if (!this.activeShare(share[1]!)) await rm(file, { force: true })
        } else if (/^draft-[a-f0-9-]+-\d+\.html$/.test(name) && !activeFiles.has(file)) {
          const info = await stat(file).catch(() => null)
          if (info && info.mtimeMs < Date.now() - EXPORT_TTL_MS) await rm(file, { force: true })
        }
      }
    } finally { this.cleaning = false }
  }
}
