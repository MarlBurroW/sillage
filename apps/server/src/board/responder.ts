import { randomUUID } from 'node:crypto'
import { and, desc, eq, isNull } from 'drizzle-orm'
import {
  cardIssues,
  cardNotes,
  cards,
  conversations,
  projects,
  worktrees,
  type BoardLinkRow,
  type CardIssueRow,
  type CardRow,
  type ProjectRow,
} from '@sillage/db'
import {
  agentConfigSchema,
  defaultConfigFor,
  readProjectDefaults,
  sessionMarker,
  type AgentConfig,
} from '@sillage/protocol'
import type { AgentRegistry } from '../agents/registry.js'
import { createConversation } from '../conversations/create.js'
import type { AppContext } from '../http/context.js'
import { createWorktree } from '../http/routes/worktrees.js'
import type { SessionManager } from '../sessions/session-manager.js'
import { readUserSettings } from '../settings/user-settings.js'
import type { GitHubComment } from './github-issues.js'

const HOUR_MS = 3_600_000
/** Le fil recopié dans le prompt : assez pour situer, read_card donne le reste. */
const THREAD_NOTES = 12
const DESCRIPTION_CHARS = 6000
const NOTE_CHARS = 2000

/** Ce qui ouvre une session de maintenance, ou lui arrive. */
export type MaintenanceEvent =
  | { kind: 'issue'; link: BoardLinkRow; issue: CardIssueRow }
  | { kind: 'comment'; link: BoardLinkRow; issue: CardIssueRow; comments: GitHubComment[] }

export type MaintenanceOutcome = 'launched' | 'messaged' | 'limited'

export interface Responder {
  respond(event: MaintenanceEvent): Promise<MaintenanceOutcome>
}

/**
 * Les sessions de maintenance d'un board relié : une par issue, ouverte au premier
 * déclencheur et rattachée à la carte ; les commentaires suivants lui arrivent en
 * message, pour qu'elle garde l'historique de ce qu'elle a déjà fait et dit.
 *
 * Sillage n'y écrit que des faits (l'issue, le commentaire, où publier et comment ne pas
 * se relancer soi-même) puis les instructions de l'utilisateur, telles quelles. Ce que
 * l'agent fait, corriger, répondre ou rien, et sous quelle identité, c'est elles qui le
 * disent.
 */
export class BoardResponder implements Responder {
  /** Lancements et messages par board, sur l'heure glissante. En mémoire : un garde-fou. */
  private readonly recent = new Map<string, number[]>()

  constructor(
    private readonly ctx: AppContext,
    private readonly sessions: SessionManager,
    private readonly registry: AgentRegistry,
  ) {}

  async respond(event: MaintenanceEvent): Promise<MaintenanceOutcome> {
    const { link, issue } = event
    const now = Date.now()
    const recent = (this.recent.get(link.projectId) ?? []).filter((at) => at > now - HOUR_MS)
    if (recent.length >= link.maxSessionsPerHour) {
      this.recent.set(link.projectId, recent)
      return 'limited'
    }
    const card = this.ctx.db.select().from(cards).where(eq(cards.id, issue.cardId)).get()
    const project = this.ctx.db.select().from(projects).where(eq(projects.id, link.projectId)).get()
    if (!card || !project) return 'limited'
    recent.push(now)
    this.recent.set(link.projectId, recent)

    // La session de l'issue, tant qu'elle existe, suit cette carte et n'a pas été
    // archivée : archiver est la façon de dire « repars de zéro ».
    const session = issue.responderId
      ? this.ctx.db
          .select({ id: conversations.id })
          .from(conversations)
          .where(and(eq(conversations.id, issue.responderId), eq(conversations.cardId, card.id), isNull(conversations.archivedAt)))
          .get()
      : undefined
    if (session && event.kind === 'comment') {
      await this.deliver(session.id, link, followUpPrompt(event))
      return 'messaged'
    }

    const id = randomUUID()
    const worktreeId = link.workspace === 'worktree' ? await this.worktree(project, link.userId, issue.number) : null
    // Posé avant le lancement : le serveur MCP de la session lit dès son démarrage si elle
    // est une session de maintenance (outils de décision), avant que la création rende la main.
    this.ctx.db.update(cardIssues).set({ responderId: id }).where(eq(cardIssues.cardId, card.id)).run()
    const row = await createConversation(this.ctx.db, this.sessions, {
      id,
      projectId: link.projectId,
      userId: link.userId,
      agent: link.sessionAgent,
      config: await this.config(link, project),
      worktreeId,
      // Rattachée sans avancer la carte : la colonne dit l'état de l'issue sur GitHub,
      // c'est l'agent qui la change s'il en a reçu l'instruction.
      cardId: card.id,
      title: `Issue #${issue.number} · ${issue.title}`.slice(0, 200),
      origin: null,
      firstMessage: {
        clientMessageId: randomUUID(),
        text: firstPrompt(event, card, this.thread(card.id), id, worktreeId ? `issue-${issue.number}` : null),
        attachments: [],
        mentions: [],
        skills: [],
      },
    })
    void row
    return 'launched'
  }

  /**
   * Un commentaire pour une session qui existe : il attend la fin du tour en cours, ou
   * l'infléchit si le board le demande et que le CLI le sait faire.
   */
  private async deliver(conversationId: string, link: BoardLinkRow, text: string): Promise<void> {
    const messageId = randomUUID()
    if (link.commentDelivery === 'steer' && (await this.sessions.steer(conversationId, messageId, text))) return
    await this.sessions.sendMessage(conversationId, messageId, text)
  }

  /** Les réglages choisis pour le board, ou ceux du projet pour ce CLI. */
  private async config(link: BoardLinkRow, project: ProjectRow): Promise<AgentConfig> {
    const agent = link.sessionAgent
    const chosen = link.sessionConfig ? agentConfigSchema.safeParse(JSON.parse(link.sessionConfig)) : null
    const base =
      (chosen?.success && chosen.data.agent === agent ? chosen.data : undefined) ??
      readProjectDefaults(project.defaultConfig)[agent] ??
      readUserSettings(this.ctx.db, link.userId).agentDefaults[agent] ??
      defaultConfigFor(agent)
    return this.registry.adapter(agent).resolveDefaults(base)
  }

  /** Le worktree `issue-<n>`, créé au besoin, repris s'il existe déjà. */
  private async worktree(project: ProjectRow, userId: string, number: number): Promise<string> {
    const name = `issue-${number}`
    const existing = this.ctx.db
      .select({ id: worktrees.id })
      .from(worktrees)
      .where(and(eq(worktrees.projectId, project.id), eq(worktrees.name, name), isNull(worktrees.removedAt)))
      .get()
    if (existing) return existing.id
    return (await createWorktree(this.ctx, project, userId, name, 'HEAD')).id
  }

  /** Les dernières notes de la carte, de la plus ancienne à la plus récente. */
  private thread(cardId: string) {
    return this.ctx.db
      .select({
        body: cardNotes.body,
        createdAt: cardNotes.createdAt,
        externalAuthor: cardNotes.externalAuthor,
        externalId: cardNotes.externalId,
        publication: cardNotes.publication,
        conversationId: cardNotes.conversationId,
      })
      .from(cardNotes)
      .where(eq(cardNotes.cardId, cardId))
      .orderBy(desc(cardNotes.createdAt))
      .limit(THREAD_NOTES)
      .all()
      .reverse()
  }
}

type ThreadNote = ReturnType<BoardResponder['thread']>[number]

function clip(text: string, max: number): string {
  const trimmed = text.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed
}

function stamp(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

/** Un commentaire cité : son auteur, sa date, son lien, puis le texte en citation. */
function quote(comment: GitHubComment): string {
  const body = clip(comment.body ?? '', NOTE_CHARS)
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
  return `@${comment.user?.login ?? 'ghost'}, ${stamp(Date.parse(comment.created_at))} — ${comment.html_url}\n${body}`
}

/** Où et comment publier, et la marque sans laquelle l'agent se relancerait lui-même. */
function publishing(link: BoardLinkRow, conversationId: string): string {
  const signature = link.identity === 'ai' ? link.signature.trim() : ''
  const added = signature
    ? `Sillage y ajoute la signature du board (${JSON.stringify(signature)}) puis ta marque de session, invisible.`
    : 'Sillage y ajoute ta marque de session, invisible ; aucune signature visible.'
  const manual = signature ? `la signature ${JSON.stringify(signature)} puis la marque` : 'la marque'
  return [
    "Pour agir sur l'issue depuis Sillage : add_card_note avec `github: true` la commente, update_issue la ferme ou la rouvre. " + added,
    `Ce que tu publies autrement (\`gh\`, API, issue, commentaire, pull request) doit se terminer par ${manual} ${sessionMarker(conversationId)} : sans elle, Sillage le prendrait pour un message extérieur et relancerait une session.`,
  ].join('\n')
}

function userInstructions(title: string, text: string): string | null {
  return text.trim() ? `${title}\n${text.trim()}` : null
}

export function firstPrompt(
  event: MaintenanceEvent,
  card: CardRow,
  thread: ThreadNote[],
  conversationId: string,
  worktree: string | null,
): string {
  const { link, issue } = event
  const labels = JSON.parse(issue.labels || '[]') as string[]
  const fresh = event.kind === 'comment' ? event.comments : []
  const history = thread
    // Les nouveaux commentaires sont déjà des notes : ils sont cités plus bas, à part.
    .filter((note) => !fresh.some((comment) => String(comment.id) === note.externalId))
    .map((note) => {
      const who = note.externalAuthor
        ? `@${note.externalAuthor} sur GitHub`
        : note.publication === 'published'
          ? 'publié depuis Sillage'
          : note.conversationId
            ? 'note locale d’une session'
            : 'note locale de l’utilisateur'
      return `[${who}, ${stamp(note.createdAt)}]\n${clip(note.body, NOTE_CHARS)}`
    })

  const what =
    event.kind === 'issue'
      ? `nouvelle issue GitHub #${issue.number}`
      : `${fresh.length > 1 ? 'nouveaux commentaires' : 'nouveau commentaire'} sur l'issue GitHub #${issue.number}`
  const parts: Array<string | null> = [
    `[Sillage — ${what}, dépôt ${link.repo}]`,
    '',
    `Session de maintenance de l'issue #${issue.number} « ${issue.title} » (${issue.url}), ouverte automatiquement par Sillage. Elle est rattachée à la carte #${card.number} du board ; les prochains commentaires de l'issue t'arriveront ici. ${worktree ? `Tu travailles dans le worktree « ${worktree} ».` : 'Tu travailles dans l’arbre principal du projet.'}`,
    '',
    publishing(link, conversationId),
    userInstructions('\nManière de répondre, selon l’utilisateur :', link.replyStyle),
    event.kind === 'issue'
      ? userInstructions('\nInstructions de l’utilisateur pour une nouvelle issue :', link.issueInstructions)
      : userInstructions('\nInstructions de l’utilisateur pour un nouveau commentaire :', link.commentInstructions),
    '',
    `L'issue : ouverte par ${issue.author ? `@${issue.author}` : 'un compte supprimé'}, ${issue.state === 'open' ? 'ouverte' : 'fermée'}${labels.length ? `, labels : ${labels.join(', ')}` : ''}.`,
    `Description :\n${clip(card.description, DESCRIPTION_CHARS) || '(vide)'}`,
  ]
  if (history.length > 0) parts.push('', `Fil de la carte (read_card ${card.number} pour tout le reste) :\n\n${history.join('\n\n')}`)
  if (fresh.length > 0) parts.push('', fresh.length > 1 ? 'Les nouveaux commentaires :' : 'Le nouveau commentaire :', '', fresh.map(quote).join('\n\n'))
  return parts.filter((part) => part !== null).join('\n')
}

export function followUpPrompt(event: MaintenanceEvent & { kind: 'comment' }): string {
  const { link, issue, comments } = event
  return [
    `[Sillage — ${comments.length > 1 ? 'nouveaux commentaires' : 'nouveau commentaire'} sur l'issue #${issue.number}]`,
    '',
    comments.map(quote).join('\n\n'),
    userInstructions('\nInstructions de l’utilisateur pour un nouveau commentaire :', link.commentInstructions),
  ]
    .filter((part) => part !== null)
    .join('\n')
}
