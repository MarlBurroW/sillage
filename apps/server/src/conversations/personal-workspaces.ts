import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { and, eq } from 'drizzle-orm'
import { personalWorkspaces, type Db } from '@sillage/db'
import { notFound } from '../http/errors.js'

/** Separate rows keep files discoverable even after the last conversation using them is deleted. */
export function createPersonalWorkspace(db: Db, root: string, userId: string, name: string) {
  const id = randomUUID()
  const row = { id, userId, name, path: join(root, userId, id), createdAt: Date.now() }
  mkdirSync(row.path, { recursive: true })
  db.insert(personalWorkspaces).values(row).run()
  return row
}

export function personalWorkspace(db: Db, id: string, userId: string) {
  const row = db.select().from(personalWorkspaces)
    .where(and(eq(personalWorkspaces.id, id), eq(personalWorkspaces.userId, userId))).get()
  if (!row) throw notFound('workspace_not_found', 'Directory not found.')
  return row
}
