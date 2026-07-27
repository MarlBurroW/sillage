import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { and, eq, inArray, isNull, lt } from 'drizzle-orm'
import { attachments, type Db } from '@sillage/db'
import { INLINE_IMAGE_TYPES, type AttachmentDto } from '@sillage/protocol'

/** Une pièce jointe jamais envoyée est un déchet : on la ramasse au bout d'un jour. */
const ORPHAN_TTL_MS = 24 * 60 * 60 * 1000

export type AttachmentRow = typeof attachments.$inferSelect

/**
 * Signatures de fichiers. Le type est déterminé par le contenu et non par l'extension
 * fournie par le client : celle-ci est choisie par l'appelant, donc elle ne prouve rien
 * sur ce que le fichier contient réellement.
 */
const SIGNATURES: { mime: string; bytes: number[] }[] = [
  { mime: 'image/png', bytes: [0x89, 0x50, 0x4e, 0x47] },
  { mime: 'image/jpeg', bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'application/pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
  { mime: 'application/zip', bytes: [0x50, 0x4b, 0x03, 0x04] },
]

function looksLikeUtf8Text(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, 4096)
  // Un octet nul ne se rencontre pas dans du texte, et sa présence suffit à trancher.
  if (sample.includes(0)) return false
  return Buffer.compare(Buffer.from(sample.toString('utf8'), 'utf8'), sample) === 0
}

export function sniffMimeType(buffer: Buffer, filename: string): string {
  // WebP se cache derrière un conteneur RIFF, donc avant les signatures simples.
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

  /**
   * Écrit le fichier puis enregistre sa trace. Le contenu ne va jamais en base :
   * SQLite n'est pas un magasin de blobs, et le journal doit rester léger à relire.
   */
  async save(input: { userId: string; filename: string; content: Buffer }): Promise<AttachmentDto> {
    const now = new Date()
    const dir = join(
      this.root,
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, '0'),
    )
    await mkdir(dir, { recursive: true })

    const id = randomUUID()
    // L'extension d'origine est conservée pour que l'agent voie un nom exploitable,
    // mais le nom sur disque reste un uuid : deux envois du même nom ne doivent pas
    // se marcher dessus.
    const storagePath = join(dir, `${id}${extname(input.filename).slice(0, 16)}`)
    await writeFile(storagePath, input.content)

    const row: AttachmentRow = {
      id,
      conversationId: null,
      userId: input.userId,
      filename: input.filename,
      mimeType: sniffMimeType(input.content, input.filename),
      sizeBytes: input.content.byteLength,
      storagePath,
      createdAt: now.getTime(),
    }
    this.db.insert(attachments).values(row).run()

    return toAttachmentDto(row)
  }

  /** Pièces jointes appartenant à cet utilisateur et pas encore envoyées. */
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
        ),
      )
      .all()
  }

  /** Rattache les fichiers au fil : ils suivront désormais sa suppression. */
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

  /**
   * Supprime les fichiers d'une conversation avant que la base ne l'efface.
   *
   * La cascade des clés étrangères ne retire que les lignes : sans ce passage, chaque
   * conversation supprimée laisserait ses fichiers sur le disque pour toujours.
   */
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

  /**
   * Fichiers téléversés puis abandonnés sans envoi. Sans ce ramassage, chaque
   * hésitation devant le composer laisserait un fichier sur le disque à vie.
   */
  async purgeOrphans(): Promise<number> {
    const stale = this.db
      .select()
      .from(attachments)
      .where(
        and(
          isNull(attachments.conversationId),
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
