import { and, count, desc, eq, gt, isNull, ne, or, sql } from 'drizzle-orm'
import { automationWebhooks, cards, conversations, projectImages, scheduledTasks, worktrees, type Db } from '@sillage/db'
import { MAX_SESSION_TITLE_CHARS, sessionReference, sessionMarker, sessionTrailer } from '@sillage/protocol'

/** Project activity injected at session startup. CLIs lack others' history and may not think to query MCP; this unsolicited overview justifies its token cost. Compute rather than store notes that grow stale with undeserved authority: one fresh query per start. Durable user-managed instructions belong separately in SILLAGE.md (`instructions/store.ts`). Cover the whole project rather than `find_file_edits`' worktree scope because other branches are active work too; identify worktrees per row for agents to distinguish. */

/** Beyond this size, overviews cost more context than guidance. */
const MAX_SESSIONS = 6

/** Recent-session window: three days rather than one so Friday work remains relevant Monday. Currently working sessions always appear regardless of age. */
const RECENT_MS = 3 * 24 * 60 * 60 * 1000

interface OverviewInput {
  projectId: string
  conversationId: string
  /** Whether Sillage MCP tools are available to agents. */
  sillageMcp: boolean
}

interface Row {
  id: string
  title: string
  agent: string
  status: string
  background: number
  loops: number
  createdAt: number
  updatedAt: number
  tokens: number
  worktree: string | null
}

/** Readable ages avoid model subtraction of absolute timestamps. */
function ago(ts: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - ts) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`
}

/** Rounded work size: scale matters rather than exact counts. */
function size(tokens: number): string {
  if (tokens < 1000) return 'a few exchanges'
  return `~${Math.round(tokens / 1000)} k tokens`
}

function describe(row: Row, now: number): string {
  const working = row.status === 'running' || row.background > 0 || row.loops > 0
  const state = working
    ? row.status === 'running'
      ? 'running'
      : `background work running`
    : row.status === 'awaiting_input'
      ? 'awaiting a reply'
      : row.status === 'interrupted'
        ? 'interrupted'
        : 'finished'

  const where = row.worktree ? `worktree ${row.worktree}` : 'project root'
  return `- ${row.title} | ${sessionReference(row.id)}\n  ${row.agent}, ${state}, ${where}, ${size(row.tokens)}, opened ${ago(row.createdAt, now)}, last exchange ${ago(row.updatedAt, now)}`
}

/** Current card and preceding sessions working on it. Unlike neighboring activity, this explains the requested work; agents resuming a fourth session otherwise would miss three previous sessions. */
function cardBriefing(db: Db, input: OverviewInput): string | null {
  const card = db
    .select({ number: cards.number, title: cards.title, column: cards.column, id: cards.id })
    .from(cards)
    .innerJoin(conversations, eq(conversations.cardId, cards.id))
    .where(eq(conversations.id, input.conversationId))
    .get()
  if (!card) return null

  const [before] = db
    .select({ total: count() })
    .from(conversations)
    .where(and(eq(conversations.cardId, card.id), ne(conversations.id, input.conversationId)))
    .all()

  const previous = before?.total ?? 0
  const lines = [
    `This conversation handles card #${card.number} “${card.title}”, ${COLUMN_WORDS[card.column]}.`,
  ]

  if (previous > 0) {
    lines.push(
      `${previous} other session(s) have already worked on it: this is not a new topic.`,
    )
  }

  if (input.sillageMcp) {
    lines.push(
      `Call \`read_card\` with number ${card.number} for its full description, local attachment paths to inspect with your reading tools, notes from previous sessions, and cards referring to it. Before finishing, use \`add_card_note\` to leave the next session information it cannot rediscover itself. Use \`move_card\` to move it to review when your work is ready; done and abandoned are for the user unless they ask you to set them.`,
    )
  }

  return lines.join(' ')
}

/** Readable column names: stored values are identifiers. */
const COLUMN_WORDS: Record<string, string> = {
  todo: 'to do',
  in_progress: 'in progress',
  review: 'awaiting review',
  done: 'marked done',
  abandoned: 'marked abandoned',
}

/** Project image reminder while missing or provisional. Navigation images aid recognition but humans forget them; agents can find repository logos. New projects may lack logos, so provisional placeholders keep reminders active until replaced. Permanent images and agents without relevant tools suppress reminders. */
function imageReminder(db: Db, input: OverviewInput): string | null {
  if (!input.sillageMcp) return null

  const image = db
    .select({ provisional: projectImages.provisional })
    .from(projectImages)
    .where(eq(projectImages.projectId, input.projectId))
    .get()

  if (!image) {
    return "This project has no image in Sillage, which helps the user recognize it at a glance. Without distracting from the requested work, for example after finishing it, set one with `set_project_image`. First look for a logo or icon in the repository: favicon, `logo.*`, `icon.*`, `public`, `assets` or `static` folders, or the README header. If none exists, draw a simple SVG representing the project, or generate an image if you have a suitable tool, and set `provisional: true` so later sessions know it awaits a real logo."
  }

  if (image.provisional) {
    return "This project's image in Sillage is provisional because no logo was available. Once the project has a real logo, particularly if you create or add it, replace the image with `set_project_image`."
  }

  return null
}

/** Forge markers for webhook-enabled projects identify session-originated issues/PRs and bound launch chains. Omit instructions without webhooks to avoid needless context cost. */
function forgeMarkerReminder(db: Db, input: OverviewInput): string | null {
  const hooks = db
    .select({ name: scheduledTasks.name, enabled: scheduledTasks.enabled })
    .from(automationWebhooks)
    .innerJoin(scheduledTasks, eq(scheduledTasks.id, automationWebhooks.taskId))
    .where(eq(scheduledTasks.projectId, input.projectId))
    .all()
  if (hooks.length === 0) return null
  const names = hooks.map((hook) => `“${hook.name}”${hook.enabled ? '' : ' (paused)'}`).join(', ')
  return `This project has webhook-triggered automations (${names}). End anything you publish on its forge (issue, pull request, comment, review) with ${sessionMarker(input.conversationId)}, and commit messages with the trailer \`${sessionTrailer(input.conversationId)}\`: Sillage uses these to recognize your work and prevent agents from triggering each other in a loop. Never apply a label or post a command that triggers an automation unless the user asks you to.`
}

/** A session-specific instruction reaches every CLI through the same startup context. */
export function sessionTitleReminder(db: Db, input: { projectId: string | null; conversationId: string; sillageMcp: boolean }): string | null {
  if (!input.sillageMcp) return null
  const current = db.select({ title: conversations.title, user: conversations.titleSetByUser, agent: conversations.titleSetByAgent })
    .from(conversations)
    .where(and(eq(conversations.id, input.conversationId), input.projectId ? eq(conversations.projectId, input.projectId) : isNull(conversations.projectId)))
    .get()
  if (!current || current.user) return null
  if (current.agent) {
    return `This session's title is ${JSON.stringify(current.title)}. Keep it unless the main topic changes. If the request genuinely changes topic, update it with the \`sillage\` server's \`rename_session\` tool, using 3 to 6 words in the user's language (${MAX_SESSION_TITLE_CHARS} characters maximum).`
  }
  return `Once you understand the request, call the \`sillage\` server's \`rename_session\` tool to give this session a short, descriptive title: aim for 3 to 6 words, at most ${MAX_SESSION_TITLE_CHARS} characters, in the user's language. Name the concrete topic, for example “Sidebar redesign” or “Fix login”, rather than copying their sentence or announcing progress. The title helps the user find the conversation; set it without asking for confirmation or interrupting the requested work. Change it later only if the main topic changes.`
}

/** Null when empty: repeated empty overviews teach models to ignore them, making future relevant content unnoticed. */
export function projectOverview(db: Db, input: OverviewInput): string | null {
  const now = Date.now()
  // Cards before images: requested work precedes suggestions.
  const referenceReminder = input.sillageMcp
    ? 'To cite a session in your replies, write session:<id> using its exact Sillage identifier: the interface turns it into a link with its title and details. read_conversation accepts this identifier or reference to read the thread, including archives. A mention alone is not a request to message another agent.'
    : null
  const briefing = [referenceReminder, sessionTitleReminder(db, input), cardBriefing(db, input), forgeMarkerReminder(db, input), imageReminder(db, input)]
    .filter((part) => part !== null)
    .join('\n\n') || null

  const rows = db
    .select({
      id: conversations.id,
      title: conversations.title,
      agent: conversations.agent,
      status: conversations.status,
      background: conversations.backgroundCount,
      loops: conversations.loopCount,
      createdAt: conversations.createdAt,
      updatedAt: conversations.updatedAt,
      tokens: sql<number>`${conversations.inputTokens} + ${conversations.outputTokens}`,
      worktree: worktrees.name,
    })
    .from(conversations)
    .leftJoin(worktrees, eq(worktrees.id, conversations.worktreeId))
    .where(
      and(
        eq(conversations.projectId, input.projectId),
        ne(conversations.id, input.conversationId),
        isNull(conversations.archivedAt),
        or(
          eq(conversations.status, 'running'),
          gt(conversations.backgroundCount, 0),
          gt(conversations.loopCount, 0),
          gt(conversations.updatedAt, now - RECENT_MS),
        ),
      ),
    )
    .orderBy(desc(conversations.updatedAt))
    .limit(MAX_SESSIONS)
    .all() as Row[]

  // Cards matter even on quiet projects because they state requested work,
  // unlike neighboring activity.
  if (rows.length === 0) return briefing

  const working = rows.filter(
    (row) => row.status === 'running' || row.background > 0 || row.loops > 0,
  )

  const parts = briefing ? [briefing] : []
  parts.push(
    `Other Sillage sessions in this project, ${working.length > 0 ? `${working.length} currently working` : 'none currently working'}:`,
    rows.map((row) => describe(row, now)).join('\n'),
  )

  if (working.length > 0) {
    parts.push(
      "An active session may be working in the same tree: before undoing a change you did not make, check where it came from.",
    )
  }

  if (input.sillageMcp) {
    parts.push(
      'The `sillage` server tools provide further context: `search_history` and `read_conversation` for earlier decisions, `list_sessions` and `find_file_edits` for current work by others, `send_session_message` to alert or ask another session when it cannot wait for the user, `notify_when_done` to resume when it finishes instead of polling, `broadcast_session_message` before an action affecting all working sessions, `list_cards` and `read_card` for planned project work, `create_card` to record work outside your scope, `start_session` to delegate work to a new session when the user asks, `list_worktrees` and `create_worktree` to work separately from others instead of using `git worktree add`, which Sillage would not track, `schedule_task` to schedule recurring or deferred work that survives this session, `create_automation` to start a session on webhook calls (a labeled issue or failed CI), and `list_actions` and `register_action` for project buttons that launch a server, tests or a script.',
    )
  }

  return parts.join('\n\n')
}
