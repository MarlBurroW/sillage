import { randomUUID } from 'node:crypto'
import { eq, isNotNull, min } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { getSessionInfo, listSessions } from '@anthropic-ai/claude-agent-sdk'
import { conversations, projects, type ConversationRow } from '@sillage/db'
import type { ClaudeSessionsDto, ClaudeSyncDto } from '@sillage/protocol'
import type { AgentRegistry } from '../../agents/registry.js'
import {
  TRANSCRIPT_RAW_FORMAT,
  readSubAgentTranscripts,
  readTranscript,
  translateTranscript,
  type TranslatedEvent,
} from '../../agents/claude/transcript.js'
import type { EventLog } from '../../events/event-log.js'
import type { SessionManager } from '../../sessions/session-manager.js'
import { readUserSettings } from '../../settings/user-settings.js'
import { resolveConversationCwd } from '../../workspace.js'
import { badRequest, notFound } from '../errors.js'
import { requireUser } from '../require-user.js'
import type { AppContext } from '../context.js'
import { conversationToDto } from './conversations.js'

/**
 * Reprise dans Sillage de sessions commencées avec le CLI Claude Code.
 *
 * Le daemon partage le compte et le disque du CLI : les transcripts de
 * `~/.claude/projects` sont directement lisibles, et `resume` continue une session
 * quel que soit l'outil qui l'a ouverte. Importer revient donc à créer une
 * conversation portant l'identifiant natif, et à reconstruire le journal depuis le
 * transcript (invariant I2). Rien n'est dupliqué côté CLI : les tours faits ensuite
 * dans Sillage s'écrivent dans le même fichier, et `claude --resume` les montre.
 *
 * La seule contrainte reste de ne pas piloter la même session des deux côtés en même
 * temps ; la resynchronisation rattrape l'affichage après un passage par le CLI, elle
 * ne protège pas d'une écriture simultanée.
 */

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
  const loadProject = (projectId: string, userId: string) => {
    const project = ctx.db.select().from(projects).where(eq(projects.id, projectId)).get()
    if (!project) throw notFound('project_not_found', 'Project not found.')
    if (project.ownerId !== userId && project.visibility !== 'shared') {
      throw notFound('project_not_found', 'Project not found.')
    }
    return project
  }

  /** Identifiants de session déjà rattachés à une conversation, tous projets confondus. */
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
        // Une session d'un autre dossier ne serait pas reprenable : le CLI retrouve
        // son transcript par le chemin, pas par le seul identifiant.
        .filter((session) => session.cwd === undefined || session.cwd === project.workspacePath)
        .filter((session) => !linked.has(session.sessionId))
        // Sans premier message, il n'y a rien à reprendre : ce sont des sessions
        // ouvertes puis refermées aussitôt.
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

    const entries = await readTranscript(project.workspacePath, sessionId)
    if (entries.length === 0) {
      throw notFound(
        'transcript_not_found',
        'No transcript found for this session in the project folder.',
      )
    }

    const sidechains = await readSubAgentTranscripts(project.workspacePath, sessionId, entries)
    const translated = translateTranscript(entries, project.workspacePath, sidechains)
    const info =
      (await getSessionInfo(sessionId, { dir: project.workspacePath }).catch(() => null)) ?? null
    const firstPrompt = translated.events.find(
      (item) => item.event.type === 'message.completed' && item.event.role === 'user',
    )
    const firstText =
      firstPrompt?.event.type === 'message.completed'
        ? (firstPrompt.event.blocks.find((block) => block.type === 'text')?.text ?? null)
        : null

    // Les défauts du compte, comme pour une conversation ouverte depuis l'interface :
    // adopter une session du CLI n'est pas une raison de repartir des défauts du
    // protocole, que la personne a peut-être justement changés.
    const defaults = readUserSettings(ctx.db, user.id).agentDefaults.claude
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
      // Une session importée depuis le CLI ne vient d'aucune carte.
      cardId: null,
      userId: user.id,
      title: importTitle(info, firstText),
      titleSetByUser: false,
      agent: 'claude',
      agentSessionId: sessionId,
      forkedFromId: null,
      createdByTokenId: null,
      originLabel: null,
      config: JSON.stringify(config),
      status: 'idle',
      backgroundCount: 0,
      loopCount: 0,
      lastSeq: 0,
      lastNotableSeq: 0,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      // Repris par `appendBatch` avec les événements de la session adoptée.
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
    ctx.db.insert(conversations).values(row).run()

    const opening: TranslatedEvent = {
      ts: translated.events[0]?.ts ?? now,
      event: {
        type: 'session.started',
        agent: 'claude',
        agentSessionId: sessionId,
        // Le transcript ne déclare ni la liste d'outils ni toujours un modèle : on
        // journalise ce qu'il dit, pas ce qu'on suppose.
        model: translated.model ?? '',
        cwd: project.workspacePath,
        tools: [],
      },
    }
    const lastSeq = log.appendBatch(row.id, [opening, ...translated.events], TRANSCRIPT_RAW_FORMAT)

    return reply.status(201).send(conversationToDto({ ...row, lastSeq }, user.id, 0, null))
  })

  /**
   * Rattrape dans le journal les tours faits au CLI depuis le dernier point commun.
   *
   * Appelée à l'ouverture d'une conversation Claude : le CLI relit toujours le
   * transcript complet, mais le journal de Sillage est sa propre copie, et sans ce
   * rattrapage l'affichage ignorerait ce qui s'est passé hors de Sillage.
   */
  app.post('/api/conversations/:id/claude-sync', async (request): Promise<ClaudeSyncDto> => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }

    const conversation = ctx.db.select().from(conversations).where(eq(conversations.id, id)).get()
    if (!conversation) throw notFound('conversation_not_found', 'Conversation not found.')
    if (conversation.userId !== user.id) throw notFound('conversation_not_found', 'Conversation not found.')
    if (conversation.agent !== 'claude') {
      throw badRequest('claude_only', 'Only Claude Code conversations can be resynced.')
    }

    // Rien à faire tant que la session n'a jamais démarré, ou qu'un tour est en
    // cours : le transcript est alors en train de s'écrire, on repassera.
    if (!conversation.agentSessionId) return { imported: 0 }
    if (conversation.status === 'running' || conversation.status === 'awaiting_input') {
      return { imported: 0 }
    }

    const cwd = resolveConversationCwd(ctx.db, conversation)
    const entries = await readTranscript(cwd, conversation.agentSessionId)
    if (entries.length === 0) return { imported: 0 }

    const anchors = log.importAnchors(id)
    let after = entries
    if (anchors.uuids.size > 0) {
      let anchorIndex = -1
      entries.forEach((entry, index) => {
        if (typeof entry.uuid === 'string' && anchors.uuids.has(entry.uuid)) anchorIndex = index
      })
      // Journal et transcript sans point commun : reprendre au hasard doublerait le
      // fil, on ne touche à rien.
      if (anchorIndex === -1) return { imported: 0 }
      after = entries.slice(anchorIndex + 1)
    } else if (conversation.lastSeq > 0) {
      return { imported: 0 }
    }
    if (after.length === 0) return { imported: 0 }

    // Un fil de sous-agent vit dans son propre fichier, avec sa propre chronologie :
    // le découpage au point commun ne lui convient pas, et l'`uuid` non plus, la
    // plupart de ses entrées ne laissant aucun `raw` qui en porte un. C'est donc tout
    // ou rien, par sous-agent : dès qu'il a laissé la moindre trace au journal, on le
    // tient pour importé.
    const sidechains = await readSubAgentTranscripts(cwd, conversation.agentSessionId, entries)
    for (const toolCallId of sidechains.keys()) {
      if (anchors.subAgentIds.has(toolCallId)) sidechains.delete(toolCallId)
    }

    const events = translateTranscript(after, cwd, sidechains).events.filter((item) => {
      // Un tour interrompu peut laisser son appel d'outil après le point commun alors
      // que le flux vivant l'a déjà journalisé. Le début compte autant que le résultat :
      // un `tool.started` en double rouvre le tour dans le fil replié.
      if (item.event.type === 'tool.started') {
        return !anchors.startedToolCallIds.has(item.event.toolCallId)
      }
      if (item.event.type === 'tool.completed' || item.event.type === 'file.edited') {
        return !anchors.completedToolCallIds.has(item.event.toolCallId)
      }
      return true
    })
    if (events.length === 0) return { imported: 0 }
    const imported = events.length

    // Rien ne tournera plus après ce rattrapage : `releaseRunner` juste en dessous en
    // fait la garantie. Le lot doit donc laisser le fil au repos, sinon un tour ouvert
    // en son milieu resterait affiché « en cours » à chaque rechargement. Le
    // traducteur ne pose sa propre clôture que pour un tour qu'il a vu s'ouvrir, ce
    // qu'une reprise en plein tour ne lui montre jamais.
    const last = events.at(-1)?.event.type
    if (last !== 'turn.completed' && last !== 'session.ended') {
      events.push({
        ts: events.at(-1)?.ts ?? Date.now(),
        event: { type: 'session.ended', reason: 'interrupted' },
      })
    }

    // Un runner encore chaud garde un contexte qui ignore ces tours : on l'arrête,
    // la reprise au prochain message repartira du fichier, qui a tout. Un tour a pu
    // démarrer pendant la lecture du transcript, après la vérification de statut
    // ci-dessus : il journalise lui-même ce qu'il produit, importer par-dessus
    // doublerait le fil.
    if (!(await sessions.releaseRunner(id))) return { imported: 0 }

    log.appendBatch(id, events, TRANSCRIPT_RAW_FORMAT)
    return { imported }
  })
}
