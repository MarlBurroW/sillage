import { randomUUID } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { agentRequests, worktrees, type AgentRequestRow, type ProjectRow } from '@sillage/db'
import { formatSessionMessage, type DeliveryReason } from '@sillage/protocol'
import { createConversation } from '../conversations/create.js'
import type { AppContext } from '../http/context.js'
import { advanceCardOnLaunch } from '../http/routes/cards.js'
import { createWorktree } from '../http/routes/worktrees.js'
import type { WorktreeStatusService } from '../worktrees/status-service.js'
import { findCard } from './agent-requests-cards.js'
import { describeEffort, describeModel, describePermissions, type LaunchConfigs } from './agent-requests-models.js'
import { Refusal, type Requester, type StartSessionPayload } from './agent-requests-shared.js'
import { assertWorktreeName } from './agent-requests-worktrees.js'
import type { SessionManager } from './session-manager.js'

/** `start_session`: the sessions agents launch, and the chain-depth limit shared with webhook launches. */

/** Maximum launch-chain depth: human sessions launch one session, which may launch one final session. Further levels drift from human oversight and create unintended swarms. */
export const MAX_LAUNCH_DEPTH = 2

/** Longer missions belong in files referenced by mission prompts. */
export const MAX_LAUNCH_PROMPT_CHARS = 20000

export class SessionLaunches {
  constructor(
    private readonly ctx: AppContext,
    private readonly sessions: SessionManager,
    private readonly configs: LaunchConfigs,
    private readonly worktreeStatus?: WorktreeStatusService,
  ) {}

  // --- start_session -------------------------------------------------------------

  async startSession(
    request: AgentRequestRow,
    requester: Requester,
    project: ProjectRow,
    payload: StartSessionPayload,
  ): Promise<{ text: string; launchedId: string }> {
    const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : ''
    if (!prompt) throw new Refusal('The `prompt` parameter is required: the new session\'s mission.')
    if (prompt.length > MAX_LAUNCH_PROMPT_CHARS) {
      throw new Refusal(
        `Mission too long (${prompt.length} characters, maximum ${MAX_LAUNCH_PROMPT_CHARS}). Put details in a file and cite it.`,
      )
    }

    this.assertLaunchAllowed(requester)

    const agent = this.configs.parseAgent(payload.agent, requester.agent)
    const config = await this.configs.launchConfig(agent, project, requester.userId, payload, requester.apiToken)
    const worktreeId = await this.launchTree(requester, project, payload.worktree)
    const card = findCard(this.ctx.db, project.id, payload.card)
    const title =
      typeof payload.title === 'string' && payload.title.trim() ? payload.title.trim().slice(0, 200) : undefined

    const row = await createConversation(this.ctx.db, this.sessions, {
      projectId: project.id,
      userId: requester.userId,
      agent,
      config,
      worktreeId,
      cardId: card?.id ?? null,
      title,
      titleSource: prompt,
      origin: requester.apiToken ? { tokenId: requester.apiToken.id, label: requester.apiToken.label } : null,
      firstMessage: {
        clientMessageId: randomUUID(),
        // Account-launched missions arrive bare like user input,
        // without provenance notes referencing nonexistent sessions.
        text: requester.id
          ? formatSessionMessage({
              kind: 'launch',
              from: requester.id,
              title: requester.title,
              ...(requester.fromProject ? { project: requester.fromProject } : {}),
              agent: requester.agent,
              messageId: request.id,
              body: prompt,
            })
          : prompt,
        attachments: [],
        mentions: [],
        skills: [],
      },
    })
    if (card) advanceCardOnLaunch(this.ctx, card.id)

    const tree = worktreeId
      ? (this.ctx.db.select({ name: worktrees.name }).from(worktrees).where(eq(worktrees.id, worktreeId)).get()
          ?.name ?? worktreeId)
      : null
    const lines = [
      `Session started: “${row.title}”, id ${row.id}.`,
      `CLI ${agent}, model ${describeModel(config)}, effort ${describeEffort(config)}.`,
      tree ? `Working in worktree “${tree}”.` : 'Working at the project root.',
      card ? `Attached to card #${card.number} “${card.title}”.` : null,
      describePermissions(config),
      requester.personal || !requester.id
        ? 'The user sees it in Sillage. Use read_session or wait_for_session for progress, and interrupt_session to stop its turn. Reuse this ID to continue the mission.'
        : requester.fromProject
          ? `The user sees it in Sillage, in project “${project.name}”. To be notified when it finishes, call notify_when_done with this ID and project="${project.name}", then end your turn if you have no independent work.`
          : 'The user sees it in Sillage. To be notified when it finishes, call notify_when_done with this ID, then end your turn if you have no independent work.',
    ]
    return { text: lines.filter(Boolean).join('\n'), launchedId: row.id }
  }

  /** Launch depth safeguard. Walk ancestry through requests retaining created session IDs, avoiding conversation columns needed solely by this module. */
  private assertLaunchAllowed(requester: Requester): void {
    const refusal = launchRefusal(this.ctx.db, requester.id)
    if (refusal) throw new Refusal(refusal.message)
  }

  /** Launched-session working location. Default to the launcher's tree for 'continue this elsewhere'. Unrelated bugs often deserve named worktrees; `@root` selects project roots. */
  private async launchTree(
    requester: Requester,
    project: ProjectRow,
    value: unknown,
  ): Promise<string | null> {
    if (value === undefined || value === null || value === '') return requester.worktreeId
    if (typeof value !== 'string') throw new Refusal('The `worktree` parameter must be a string.')
    const name = value.trim()
    if (name === '@root') return null

    const existing = this.ctx.db
      .select({ id: worktrees.id })
      .from(worktrees)
      .where(and(eq(worktrees.projectId, project.id), eq(worktrees.name, name), isNull(worktrees.removedAt)))
      .get()
    if (existing) return existing.id

    assertWorktreeName(name)
    const row = await createWorktree(this.ctx, project, requester.userId, name, 'HEAD')
    this.worktreeStatus?.forget(project.id)
    return row.id
  }
}

/** Why `from` cannot launch more sessions, or null: excessive chain depth. No limit on how many sessions one session launches: a user delegating a large job needs them all, and refusals only made agents wait. Shared with webhooks: session-marked calls count as its `webhook_launch`, applying the same limit whether chains use start_session or GitHub issues. */
export function launchRefusal(
  db: AppContext['db'],
  from: string,
): { reason: DeliveryReason; message: string } | null {
  let depth = 0
  let current = from
  while (depth <= MAX_LAUNCH_DEPTH) {
    const parent = db
      .select({ from: agentRequests.conversationId })
      .from(agentRequests)
      .where(eq(agentRequests.launchedConversationId, current))
      .get()
    if (!parent) break
    depth += 1
    current = parent.from
  }
  if (depth >= MAX_LAUNCH_DEPTH) {
    return {
      reason: { code: 'chain_depth', params: { depth, max: MAX_LAUNCH_DEPTH } },
      // Agent messages use English like all Sillage model-facing text;
      // coded reasons go to interfaces for translation.
      message: `Refused: this session was itself launched by another agent-launched session (${depth} levels). Launch chains cannot exceed ${MAX_LAUNCH_DEPTH}. Create a card with create_card, or suggest that the user start the session themselves.`,
    }
  }

  return null
}
