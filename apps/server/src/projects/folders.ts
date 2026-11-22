import { randomUUID } from 'node:crypto'
import { and, asc, eq } from 'drizzle-orm'
import { projectFolders, writeTransaction, type Db, type UserRow } from '@sillage/db'
import type { ProjectFolderDto } from '@sillage/protocol'
import type { AppContext } from '../http/context.js'
import { assertScopeWriter } from '../http/scope-access.js'
import { assertAdditionalFolder, canonicalExplorerFolder, canonicalMainFolder } from './folder-path.js'

export function listProjectFolders(db: Db, projectId: string): ProjectFolderDto[] {
  return db.select().from(projectFolders).where(eq(projectFolders.projectId, projectId))
    .orderBy(asc(projectFolders.path)).all()
}

export async function attachProjectFolder(ctx: AppContext, user: UserRow, projectId: string, input: string): Promise<ProjectFolderDto> {
  assertScopeWriter(ctx, user, projectId)
  const path = await canonicalExplorerFolder(input)
  return writeTransaction(ctx.db, tx => {
    // The main folder can change or the project disappear while validating the attached path.
    const project = assertScopeWriter(ctx, user, projectId)!
    assertAdditionalFolder(canonicalMainFolder(project.workspacePath), path)
    tx.insert(projectFolders).values({ id: randomUUID(), projectId, path }).onConflictDoNothing().run()
    return tx.select().from(projectFolders)
      .where(and(eq(projectFolders.projectId, projectId), eq(projectFolders.path, path))).get()!
  })
}
