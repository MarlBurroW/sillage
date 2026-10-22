import { eq } from 'drizzle-orm'
import { projectImages, type Db } from '@sillage/db'
import type { ProjectImageDto } from '@sillage/protocol'

/** Project image type detected from content, or null for nonimages. MCP duplicates this classification (`apps/server/src/mcp/sillage-mcp.mjs`) because it cannot import this module; both must stay consistent. */
export function sniffProjectImage(buffer: Buffer): string | null {
  if (buffer.subarray(0, 4).toString('latin1') === '\x89PNG') return 'image/png'
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif'
  if (
    buffer.subarray(0, 4).toString('latin1') === 'RIFF' &&
    buffer.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return 'image/webp'
  }
  // SVG is text: XML prologues, doctypes or comments may precede the root tag,
  // so search the beginning rather than only the first byte.
  if (!buffer.includes(0) && /<svg[\s>]/i.test(buffer.subarray(0, 4096).toString('utf8'))) {
    return 'image/svg+xml'
  }
  return null
}

export function projectImageDto(
  projectId: string,
  image: { updatedAt: number; provisional: boolean } | null | undefined,
): ProjectImageDto | null {
  if (!image) return null
  return { url: `/api/projects/${projectId}/image?v=${image.updatedAt}`, provisional: image.provisional }
}

/** Replaces or initially sets the project image. */
export function writeProjectImage(
  db: Db,
  projectId: string,
  image: { mimeType: string; data: Buffer; provisional: boolean },
): { updatedAt: number; provisional: boolean } {
  const row = { projectId, ...image, updatedAt: Date.now() }
  db.insert(projectImages)
    .values(row)
    .onConflictDoUpdate({ target: projectImages.projectId, set: row })
    .run()
  return row
}

export function readProjectImage(db: Db, projectId: string) {
  return db.select().from(projectImages).where(eq(projectImages.projectId, projectId)).get()
}
