import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { and, eq, inArray, isNull, lt } from 'drizzle-orm'
import { attachments, type Db } from '@sillage/db'
import { INLINE_IMAGE_TYPES, type AttachmentDto } from '@sillage/protocol'

/** Unsent attachments are garbage collected after one day. */
const ORPHAN_TTL_MS = 24 * 60 * 60 * 1000

export type AttachmentRow = typeof attachments.$inferSelect

/** File signatures. Determine types by content rather than client-provided extensions, which callers choose and therefore prove nothing about contents. */
const SIGNATURES: { mime: string; bytes: number[] }[] = [
  { mime: 'audio/mpeg', bytes: [0x49, 0x44, 0x33] },
  { mime: 'audio/flac', bytes: [0x66, 0x4c, 0x61, 0x43] },
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
  { mime: 'application/zip', bytes: [0x50, 0x4b, 0x03, 0x04] },
]

function looksLikeUtf8Text(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 4096)
  // Null bytes do not occur in text and suffice to classify files.
  if (sample.includes(0)) return false
  return Buffer.compare(Buffer.from(sample.toString('utf8'), 'utf8'), sample) === 0
}

export function sniffMimeType(buffer: Buffer, filename: string): string {
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WAVE') return 'audio/wav'
  if (buffer.subarray(0, 4).toString() === 'OggS' && (buffer.includes(Buffer.from('OpusHead'), 20) || buffer.includes(Buffer.from('vorbis'), 20))) return 'audio/ogg'
  // WebP uses RIFF containers, so check before simple signatures.
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') {
    return 'image/webp'
  }

  for (const { mime, bytes } of SIGNATURES) {
    if (bytes.every((byte, index) => buffer[index] === byte)) return mime
  }

  if (looksLikeUtf8Text(buffer)) {
    return extname(filename).toLowerCase() === '.md' ? 'text/markdown' : 'text/plain'
  }
  return 'application/octet-stream'
}

export function isInlineImage(mimeType: string): boolean {
  return (INLINE_IMAGE_TYPES as readonly string[]).includes(mimeType)
}

export function toAttachmentDto(row: AttachmentRow): AttachmentDto {
  return {
    id: row.id,
    filename: row.filename,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt,
    inlineImage: isInlineImage(row.mimeType),
  }
}

export class AttachmentStore {
  constructor(
    private readonly db: Db,
    readonly root: string,
  ) {}

  /** Writes files then records metadata. Contents never enter the database: SQLite is not blob storage, and journals must remain cheap to replay. */
  async save(input: { userId: string; filename: string; content: Buffer; cardId?: string }): Promise<AttachmentDto> {
    const now = new Date()
    const dir = join(
      this.root,
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, '0'),
    )
    await mkdir(dir, { recursive: true })

    const id = randomUUID()
    // Retain original extensions so agents see usable names,
    // but disk names remain UUIDs so identical upload names cannot
    // overwrite one another.
    const storagePath = join(dir, `${id}${extname(input.filename).slice(0, 16)}`)
    await writeFile(storagePath, input.content)

    const row: AttachmentRow = {
      id,
      conversationId: null,
      cardId: input.cardId ?? null,
      userId: input.userId,
      filename: input.filename,
      mimeType: sniffMimeType(input.content, input.filename),
      sizeBytes: input.content.byteLength,
      storagePath,
      createdAt: now.getTime(),
    }
    try {
      this.db.insert(attachments).values(row).run()
    } catch (error) {
      await rm(storagePath, { force: true })
      throw error
    }

    return toAttachmentDto(row)
  }

  /** Attachments owned by this user and not yet sent. */
  listClaimable(userId: string, ids: string[]): AttachmentRow[] {
    if (ids.length === 0) return []
    return this.db
      .select()
      .from(attachments)
      .where(
        and(
          inArray(attachments.id, ids),
          eq(attachments.userId, userId),
          isNull(attachments.conversationId),
          isNull(attachments.cardId),
        ),
      )
      .all()
  }

  /** Attaches files to conversations so subsequent deletion cascades to them. */
  claim(ids: string[], conversationId: string): void {
    if (ids.length === 0) return
    this.db.update(attachments).set({ conversationId }).where(inArray(attachments.id, ids)).run()
  }

  get(id: string): AttachmentRow | undefined {
    return this.db.select().from(attachments).where(eq(attachments.id, id)).get()
  }

  async remove(id: string): Promise<void> {
    const row = this.get(id)
    if (!row) return
    this.db.delete(attachments).where(eq(attachments.id, id)).run()
    await rm(row.storagePath, { force: true })
  }

  /** Deletes conversation files before database removal. Foreign-key cascades delete rows only; otherwise deleted conversations would leave disk files forever. */
  async removeForConversations(conversationIds: string[]): Promise<number> {
    if (conversationIds.length === 0) return 0

    const rows = this.db
      .select()
      .from(attachments)
      .where(inArray(attachments.conversationId, conversationIds))
      .all()

    for (const row of rows) await rm(row.storagePath, { force: true })
    return rows.length
  }

  /** Ticket files follow ticket and project deletion. */
  async removeForCards(cardIds: string[]): Promise<void> {
    if (!cardIds.length) return
    const rows = this.db.select().from(attachments).where(inArray(attachments.cardId, cardIds)).all()
    for (const row of rows) await this.remove(row.id)
  }

  /** Uploads abandoned before sending. Without collection, every hesitation at the composer would leave permanent disk files. */
  async purgeOrphans(): Promise<number> {
    const stale = this.db
      .select()
      .from(attachments)
      .where(
        and(
          isNull(attachments.conversationId),
          isNull(attachments.cardId),
          lt(attachments.createdAt, Date.now() - ORPHAN_TTL_MS),
        ),
      )
      .all()

    for (const row of stale) {
      this.db.delete(attachments).where(eq(attachments.id, row.id)).run()
      await rm(row.storagePath, { force: true })
    }
    return stale.length
  }
}
