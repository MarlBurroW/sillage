import { constants } from 'node:fs'
import { copyFile, lstat, mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { eq } from 'drizzle-orm'
import { projects, type ConversationRow } from '@sillage/db'
import { continueInProjectBodySchema, parseAgentConfig } from '@sillage/protocol'
import type { AppContext } from '../http/context.js'
import { badRequest, forbidden } from '../http/errors.js'
import { createProject } from '../projects/create.js'
import type { SessionManager } from '../sessions/session-manager.js'
import { refuseGitInternals, resolveConversationCwd, resolveInside, resolveRealInside } from '../workspace.js'
import { createConversation } from './create.js'

/** The useful brief is explicit; the private transcript and memory are never copied implicitly. */
export async function continueInProject(ctx: AppContext, sessions: SessionManager, source: ConversationRow, userId: string, input: unknown) {
  if (source.userId !== userId || source.projectId !== null) throw forbidden('personal_discussion_required', 'Choose one of your personal discussions.')
  const body = continueInProjectBodySchema.parse(input)
  const root = resolveConversationCwd(ctx.db, source)
  const selected = []
  let bytes = 0
  for (const path of new Set(body.files)) {
    refuseGitInternals(path)
    const absolute = await resolveRealInside(root, path)
    const info = await lstat(absolute)
    if (!info.isFile()) throw badRequest('handoff_file_required', 'Select individual regular files to copy.')
    bytes += info.size
    if (bytes > 256 * 1024 * 1024) throw badRequest('handoff_files_too_large', 'Select at most 256 MB of files.')
    selected.push({ path, absolute })
  }
  const project = await createProject(ctx, userId, body.project)
  const copied: string[] = []
  try {
    for (const file of selected) {
      const destination = resolveInside(project.workspacePath, file.path)
      await mkdir(dirname(destination), { recursive: true })
      await resolveRealInside(project.workspacePath, dirname(destination))
      await copyFile(file.absolute, destination, constants.COPYFILE_EXCL)
      copied.push(destination)
    }
    const row = await createConversation(ctx.db, sessions, {
      projectId: project.id, userId, agent: source.agent, config: parseAgentConfig(source.config),
      worktreeId: null, cardId: null, title: project.name, origin: null,
      handoff: {
        fromConversationId: source.id, throughSeq: source.lastSeq, budgetTokens: 12000,
        text: `# Project brief\n\n${body.brief}\n\n${selected.length ? `Files copied into the project:\n${selected.map(file => `- ${file.path}`).join('\n')}` : 'No files were copied.'}\n\nThe source discussion remains personal. Only the brief above was shared.`,
      },
    })
    return { project, conversation: row }
  } catch (error) {
    for (const file of copied) await rm(file, { force: true })
    ctx.db.delete(projects).where(eq(projects.id, project.id)).run()
    throw error
  }
}
