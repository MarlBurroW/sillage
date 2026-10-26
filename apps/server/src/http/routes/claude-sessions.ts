import { randomUUID } from 'node:crypto'
import { eq, isNotNull, min } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getSessionInfo, listSessions } from '@anthropic-ai/claude-agent-sdk'
import { conversations, projects, type ConversationRow } from '@sillage/db'
import {
  readProjectDefaults,
  type ClaudeSessionsDto,
  type ClaudeSyncDto,
} from '@sillage/protocol'
import type { AgentRegistry } from '../../agents/registry.js'
import { type TranslatedEvent } from '../../agents/claude/transcript.js'
import { importPreparedTranscript, prepareTranscript, savedTranscript } from '../../agents/claude/transcript-sync.js'
import { TranscriptChanged } from '../../agents/claude/transcript-reader.js'
import type { EventLog } from '../../events/event-log.js'
import type { SessionManager } from '../../sessions/session-manager.js'
import { readUserSettings } from '../../settings/user-settings.js'
import { resolveConversationCwd } from '../../workspace.js'
import { samePath } from '../../agents/paths.js'
import { badRequest, notFound } from '../errors.js'
import { requireUser } from '../require-user.js'
import type { AppContext } from '../context.js'
import { conversationToDto } from './conversations.js'

/** Imports sessions started in the Claude Code CLI into Sillage. The daemon shares the CLI's account and disk: transcripts in `~/.claude/projects` are directly readable, and `resume` continues sessions regardless of their origin. Import creates a conversation with the native ID and rebuilds its journal from the transcript (invariant I2). No CLI data is duplicated: subsequent Sillage turns use the same file and appear in `claude --resume`. Do not drive the session from both tools simultaneously; resynchronization catches up the display after CLI use but does not protect against concurrent writes. */

const sessionIdSchema = z.string().uuid()

const TITLE_MAX = 60

function importTitle(info: { customTitle?: string; summary?: string } | null, firstPrompt: string | null): string {
  const fromInfo = (info?.customTitle ?? info?.summary)?.trim()
  if (fromInfo) return fromInfo

  const text = firstPrompt?.trim().replace(/\s+/g, ' ')
  if (!text) return 'Session importée'
  return text.length <= TITLE_MAX ? text : `${text.slice(0, TITLE_MAX).trimEnd()}...`
}

export function registerClaudeSessionRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  log: EventLog,
  sessions: SessionManager,
  registry: AgentRegistry,
): void {
  const syncing = new Map<string, Promise<ClaudeSyncDto>>()
  const loadProject = (projectId: string, userId: string) => {
    const project = ctx.db.select().from(projects).where(eq(projects.id, projectId)).get()
    if (!project) throw notFound('project_not_found', 'Project not found.')
    if (project.ownerId !== userId && project.visibility !== 'shared') {
      throw notFound('project_not_found', 'Project not found.')
    }
    return project
  }

  /** Session IDs already attached to conversations across all projects. */
  const linkedSessionIds = () =>
    new Set(
      ctx.db
        .select({ agentSessionId: conversations.agentSessionId })
        .from(conversations)
        .where(isNotNull(conversations.agentSessionId))
        .all()
        .map((row) => row.agentSessionId as string),
    )

  app.get('/api/projects/:id/claude-sessions', async (request): Promise<ClaudeSessionsDto> => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const project = loadProject(id, user.id)

    let found
    try {
      found = await listSessions({ dir: project.workspacePath, limit: 40 })
    } catch (err) {
      throw badRequest(
        'sessions_unavailable',
        'Unable to list CLI sessions: {reason}.',
        { reason: err instanceof Error ? err.message : String(err) },
      )
    }

    const linked = linkedSessionIds()
    return {
      sessions: found
        // Sessions from other directories cannot resume: the CLI locates transcripts
        // by path as well as ID. Compare directories using filesystem semantics because
        // case and separators vary between terminals.
        .filter((session) => session.cwd === undefined || samePath(session.cwd, project.workspacePath))
        .filter((session) => !linked.has(session.sessionId))
        // Without a first message there is nothing to resume: these sessions were
        // opened and immediately closed.
        .filter((session) => Boolean(session.firstPrompt?.trim()))
        .map((session) => ({
          sessionId: session.sessionId,
          title: (session.customTitle ?? session.summary).trim() || 'Session sans titre',
          firstPrompt: session.firstPrompt ?? null,
          gitBranch: session.gitBranch ?? null,
          lastModified: session.lastModified,
        })),
    }
  })

  app.post('/api/projects/:id/claude-sessions/:sessionId/import', async (request, reply) => {
    const user = requireUser(request)
    const params = request.params as { id: string; sessionId: string }
    const sessionId = sessionIdSchema.parse(params.sessionId)
    const project = loadProject(params.id, user.id)

    if (linkedSessionIds().has(sessionId)) {
      throw badRequest('session_already_imported', 'This session already has a conversation.')
    }

    const prepared = await prepareTranscript(project.workspacePath, sessionId)
    if (!prepared || prepared.mainEntries === 0) {
      throw notFound('transcript_not_found', 'No transcript found for this session in the project folder.')
    }
    const info = (await getSessionInfo(sessionId, { dir: project.workspacePath }).catch(() => null)) ?? null

    // Use project presets then account defaults, as for interface-created conversations:
    // adopting CLI sessions is no reason to revert to protocol defaults
    // that the user may have deliberately changed.
    const defaults =
      readProjectDefaults(project.defaultConfig).claude ??
      readUserSettings(ctx.db, user.id).agentDefaults.claude
    const config = await registry.adapter('claude').resolveDefaults(defaults)

    const [lowest] = ctx.db
      .select({ min: min(conversations.position) })
      .from(conversations)
      .where(eq(conversations.projectId, project.id))
      .all()

    const now = Date.now()
    const row: ConversationRow = {
      id: randomUUID(),
      projectId: project.id,
      worktreeId: null,
      workspaceId: null,
      // CLI-imported sessions do not originate from cards.
      cardId: null,
      userId: user.id,
      title: importTitle(info, prepared.firstPrompt),
      titleSetByUser: false,
      titleSetByAgent: false,
      agent: 'claude',
      agentSessionId: sessionId,
      forkedFromId: null,
      handoffFromId: null,
      createdByTokenId: null,
      originLabel: null,
      scheduleId: null,
      config: JSON.stringify(config),
      status: 'idle',
      backgroundCount: 0,
      loopCount: 0,
      lastSeq: 0,
      lastNotableSeq: 0,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      // Handled by `appendBatch` with the adopted session's events.
      turnCount: 0,
      journalBytes: 0,
      contextUsedTokens: null,
      contextMaxTokens: null,
      model: null,
      pinned: false,
      position: (lowest?.min ?? 0) - 1,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    }
    // Another import can finish while this request scans the transcript.
    if (linkedSessionIds().has(sessionId)) throw badRequest('session_already_imported', 'This session already has a conversation.')
    ctx.db.insert(conversations).values(row).run()

    const opening: TranslatedEvent = {
      ts: prepared.firstTs ?? now,
      event: {
        type: 'session.started',
        agent: 'claude',
        agentSessionId: sessionId,
        // Transcripts declare neither the tool list nor always a model:
        // journal what they say rather than assumptions.
        model: prepared.model ?? '',
        cwd: project.workspacePath,
        tools: [],
      },
    }
    try {
      const { lastSeq } = await importPreparedTranscript({ prepared, db: ctx.db, log, id: row.id, cwd: project.workspacePath, lastSeq: 0, opening, release: async () => true })
      return reply.status(201).send(conversationToDto({ ...row, lastSeq }, user.id, 0, null, false))
    } catch (error) {
      // A failed initial import must not reserve the native ID with a partial journal.
      ctx.db.delete(conversations).where(eq(conversations.id, row.id)).run()
      throw error
    }
  })

  /** Catches up the journal with CLI turns since the last shared entry. Called when opening Claude conversations: the CLI rereads its entire transcript, but Sillage keeps its own journal copy and would otherwise omit activity outside Sillage. */
  app.post('/api/conversations/:id/claude-sync', async (request): Promise<ClaudeSyncDto> => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }

    const conversation = ctx.db.select().from(conversations).where(eq(conversations.id, id)).get()
    if (!conversation) throw notFound('conversation_not_found', 'Conversation not found.')
    if (conversation.userId !== user.id) throw notFound('conversation_not_found', 'Conversation not found.')
    if (conversation.agent !== 'claude') {
      throw badRequest('claude_only', 'Only Claude Code conversations can be resynced.')
    }

    // Nothing to do before the session first starts or during an active turn:
    // the transcript is still being written, so try again later.
    if (!conversation.agentSessionId) return { imported: 0 }
    if (conversation.status === 'running' || conversation.status === 'awaiting_input') {
      return { imported: 0 }
    }

    const pending = syncing.get(id)
    if (pending) return pending
    const sync = (async (): Promise<ClaudeSyncDto> => {
      try {
        const cwd = resolveConversationCwd(ctx.db, conversation)
        let anchors: ReturnType<EventLog['importAnchors']> | undefined
        const prepared = await prepareTranscript(cwd, conversation.agentSessionId!, savedTranscript(ctx.db, id, conversation.lastSeq), () => anchors ??= log.importAnchors(id), conversation.lastSeq > 0)
        if (!prepared) return { imported: 0 }
        const result = await importPreparedTranscript({ prepared, db: ctx.db, log, id, cwd, lastSeq: conversation.lastSeq, anchors, release: () => sessions.releaseRunner(id) })
        return { imported: result.imported }
      } catch (error) {
        // The live CLI wins races. Committed batches keep their cursor, and the next
        // idle opening retries anything that was still changing.
        if (error instanceof TranscriptChanged) return { imported: 0 }
        throw error
      }
    })()
    syncing.set(id, sync)
    try { return await sync } finally { syncing.delete(id) }
  })
}
