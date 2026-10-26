import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { and, desc, eq } from 'drizzle-orm'
import { personalMemoryChanges, type Db } from '@sillage/db'
import { MEMORY_INDEX_FILE, type PersonalMemoryDto } from '@sillage/protocol'
import { serialized } from '../git-workflow.js'
import { deleteMemoryFile, listMemory, writeMemoryFile } from './store.js'

export function personalMemoryDir(root: string, userId: string): string {
  const dir = join(root, 'users', userId)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Capture filesystem edits too: native CLI memory and the UI share the same directory. */
export function readPersonalMemory(db: Db, dir: string, userId: string, conversationId: string | null = null): Promise<PersonalMemoryDto> {
  return serialized(dir, () => capturePersonalMemory(db, dir, userId, conversationId))
}

async function capturePersonalMemory(db: Db, dir: string, userId: string, conversationId: string | null = null): Promise<PersonalMemoryDto> {
  const files = await listMemory(dir)
  const known = db.selectDistinct({ file: personalMemoryChanges.file }).from(personalMemoryChanges)
    .where(eq(personalMemoryChanges.userId, userId)).all()
  const current = new Map(files.map(file => [file.file, file.content]))
  for (const file of new Set([...known.map(row => row.file), ...current.keys()])) {
    const previous = db.select().from(personalMemoryChanges)
      .where(and(eq(personalMemoryChanges.userId, userId), eq(personalMemoryChanges.file, file)))
      .orderBy(desc(personalMemoryChanges.createdAt), desc(personalMemoryChanges.id)).get()
    const before = previous?.after ?? null
    const after = current.get(file) ?? null
    if (before === after) continue
    db.insert(personalMemoryChanges).values({ id: randomUUID(), userId, file, before, after, conversationId, createdAt: Math.max(Date.now(), (previous?.createdAt ?? 0) + 1) }).run()
  }
  const changes = db.select().from(personalMemoryChanges).where(eq(personalMemoryChanges.userId, userId))
    .orderBy(desc(personalMemoryChanges.createdAt)).limit(100).all()
  return { mode: 'sillage', dir, files, importedFrom: null, canEdit: true, changes }
}

/** Preserve an index entry when the first note is created from the editor rather than a CLI. */
export async function writePersonalMemory(db: Db, dir: string, userId: string, file: string, content: string | null, conversationId: string | null = null): Promise<void> {
  await serialized(dir, async () => {
    await capturePersonalMemory(db, dir, userId)
    if (content === null) await deleteMemoryFile(dir, file)
    else {
      await writeMemoryFile(dir, file, content)
      if (file !== MEMORY_INDEX_FILE) {
        const index = await readFile(join(dir, MEMORY_INDEX_FILE), 'utf8').catch(() => '')
        if (!index.includes(`](${file})`)) await writeFile(join(dir, MEMORY_INDEX_FILE), `${index.trimEnd()}\n- [${file}](${file})\n`)
      }
    }
    await capturePersonalMemory(db, dir, userId, conversationId)
  })
}
