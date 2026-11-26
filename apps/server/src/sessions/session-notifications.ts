import { eq } from 'drizzle-orm'
import { conversations, type Db } from '@sillage/db'
import { conversationPath, type CliRequestKind, type SillageEvent } from '@sillage/protocol'
import type { OutgoingNotification } from '../notifications/dispatcher.js'

/** Notifiable events and their meanings. Explicit allowlist rather than implicit rules: notifying every event would make notifications unread. Retain only agent decision requests and turn completions users cannot infer remotely. */
const NOTIFIABLE: Partial<Record<SillageEvent['type'], string>> = {
  'permission.requested': 'Une autorisation est demandée',
  'question.requested': "L'agent te demande de choisir",
  'elicitation.requested': 'Un service demande une saisie',
  'plan.review_requested': 'Un plan attend ta validation',
  'mcp_install.requested': "L'agent propose d'installer un serveur MCP",
  'turn.completed': "L'agent a terminé",
}

/** Notification-layer contract without depending on its implementation. */
/** Notification routing (`notifications/dispatcher.ts`) as viewed here. */
export interface ConversationNotifier {
  dispatch(userId: string, notification: OutgoingNotification): Promise<void>
}

/** One-line CLI wait description: tool and command or question. */
function requestDetail(event: SillageEvent): string | null {
  const clip = (text: string) => (text.length > 160 ? `${text.slice(0, 160)}…` : text)
  if (event.type === 'permission.requested') {
    const input = (event.input ?? {}) as Record<string, unknown>
    const subject = [input.command, input.file_path, input.path, input.url, input.pattern].find((value) => typeof value === 'string')
    return clip(subject ? `${event.toolName} : ${String(subject)}` : event.toolName)
  }
  if (event.type === 'question.requested') return event.questions[0] ? clip(event.questions[0].question) : null
  if (event.type === 'elicitation.requested') return clip(`${event.serverName} : ${event.message}`)
  if (event.type === 'mcp_install.requested') return clip(event.name)
  return null
}

const REQUEST_KINDS: Partial<Record<SillageEvent['type'], CliRequestKind>> = {
  'permission.requested': 'permission',
  'question.requested': 'question',
  'elicitation.requested': 'elicitation',
  'plan.review_requested': 'plan',
  'mcp_install.requested': 'mcpInstall',
}

/** Notifies owners unless viewing conversations. Sockets are the only reliable presence signal: subscribed tabs already receive live events, so additional system pushes would announce content being read. Errors never propagate because notification failures must not interrupt agents (invariant I1). */
export async function notifyIfAway(
  db: Db,
  notifier: ConversationNotifier | null,
  conversationId: string,
  event: SillageEvent,
): Promise<void> {
  const title = NOTIFIABLE[event.type]
  if (!notifier || !title) return

  try {
    const conversation = db
      .select({
        userId: conversations.userId,
        title: conversations.title,
        projectId: conversations.projectId,
        scheduleId: conversations.scheduleId,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .get()
    if (!conversation) return
    // Scheduled run completion needs no announcement: hourly tasks would notify
    // twenty-four times daily. Decision requests always pass,
    // because runs remain blocked until someone responds.
    if (conversation.scheduleId && event.type === 'turn.completed') return
    const request = REQUEST_KINDS[event.type]

    // Visible target conversation: nothing. Visible elsewhere: request toasts only,
    // no turn-end toast because sidebars show it. Absent: system notification.
    await notifier.dispatch(conversation.userId, {
      kind: request ? 'cliRequest' : 'turnCompleted',
      conversationId,
      push: {
        title,
        body: conversation.title,
        url: conversationPath({ projectId: conversation.projectId, id: conversationId }),
        // Keep one displayed notification per conversation: five copies of 'agent finished'
        // add nothing beyond the latest.
        tag: conversationId,
        kind: request ?? 'turnCompleted',
      },
      toast: request
        ? {
            kind: 'cliRequest',
            request,
            conversationId,
            projectId: conversation.projectId,
            conversationTitle: conversation.title,
            detail: requestDetail(event),
          }
        : undefined,
    })
  } catch (err) {
    // Lost notifications are not conversation failures, but swallowing them
    // silently would prevent diagnosis.
    process.stderr.write(
      `[push] notification non emise pour ${conversationId} : ${
        err instanceof Error ? err.message : String(err)
      }\n`,
    )
  }
}
