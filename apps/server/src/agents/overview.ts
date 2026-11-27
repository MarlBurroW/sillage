import { AGENT_TOOL_DEFAULTS, type AgentToolFamily } from '@sillage/protocol'
import { disabledFamiliesNotice, type Families } from './agent-tools.js'
import { and, count, desc, eq, gt, isNull, ne, or, sql } from 'drizzle-orm'
import { crossProjectsEnabled } from '../projects/cross-projects.js'
import { automationWebhooks, cards, conversations, projectActions, projectImages, projects, scheduledTasks, worktrees, type Db } from '@sillage/db'
import { MAX_SESSION_TITLE_CHARS, sessionReference, sessionMarker, sessionTrailer } from '@sillage/protocol'

/** Project context injected at session startup (stable part as system prompt, moving part with the first message: see `projectOverview`). CLIs lack others' history and may not think to query MCP; this unsolicited overview justifies its token cost. Compute rather than store notes that grow stale with undeserved authority: one fresh query per start. Durable user-managed instructions belong separately in SILLAGE.md (`instructions/store.ts`). Cover the whole project rather than `find_file_edits`' worktree scope because other branches are active work too; identify worktrees per row for agents to distinguish. */

/** Beyond this size, overviews cost more context than guidance. */
const MAX_SESSIONS = 6

/** Recent-session window: three days rather than one so Friday work remains relevant Monday. Currently working sessions always appear regardless of age. */
const RECENT_MS = 3 * 24 * 60 * 60 * 1000

interface OverviewInput {
  projectId: string
  conversationId: string
  /** Whether Sillage MCP tools are available to agents. */
  sillageMcp: boolean
  /** Effective tool families: guidance never names a tool the session lacks. Null or absent: every built-in family (personal discussions, callers without switches). */
  families?: Families | null
}

const on = (input: { families?: Families | null }, family: AgentToolFamily) => input.families?.[family] ?? AGENT_TOOL_DEFAULTS[family]

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
export function ago(ts: number, now: number): string {
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

  // The card's identity is context in itself; only the tool sentence needs the Board family.
  if (input.sillageMcp && on(input, 'board')) {
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
  // The image belongs to the project owner (`http/scope-access.ts`): a member's session would be
  // refused by `set_project_image`, so it is not asked.
  const owner = db.select({ id: projects.ownerId }).from(projects).where(eq(projects.id, input.projectId)).get()?.id
  const actor = db.select({ id: conversations.userId }).from(conversations).where(eq(conversations.id, input.conversationId)).get()?.id
  if (!owner || owner !== actor) return null

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

/** Beyond this, the list costs more context than it guides; `list_actions` has the rest. */
const MAX_LISTED_ACTIONS = 10

/**
 * Project actions, so agents use and propose them. Users rarely write one by hand: unless an agent
 * offers the button, the feature goes unseen. Without actions, the agent is asked to propose the
 * commands it sees the user will rerun; with some, it learns their names and IDs, so it reads a run
 * the user mentions instead of starting it again, and does not propose a duplicate.
 */
function actionsBriefing(db: Db, input: OverviewInput): string | null {
  if (!input.sillageMcp) return null
  const rows = db
    .select({ id: projectActions.id, label: projectActions.label, kind: projectActions.kind, approvedAt: projectActions.approvedAt })
    .from(projectActions)
    .where(eq(projectActions.projectId, input.projectId))
    .orderBy(projectActions.createdAt)
    .all()

  if (rows.length === 0) {
    return "This project has no actions yet. Actions are one-click buttons in Sillage (the Actions menu, ⚡, in the conversation header) that run a project command in the user's current worktree, so they can rerun it without asking an agent. Users rarely create them by hand: proposing them is up to you. When your work shows a command the user will want to rerun (the dev server, the test suite, a type check or lint, a seed or build script), propose it with `register_action` without waiting to be asked, after the requested work or as soon as you start such a server or run such a suite. Use the commands the project really has (package scripts, Makefile, README), propose at most two per session, and never a one-off command. Then tell the user in one sentence what the button does; they review its command in the conversation before its first run."
  }

  const listed = rows.slice(0, MAX_LISTED_ACTIONS).map((row) =>
    `- “${row.label}” (${row.kind}, id ${row.id}${row.approvedAt ? '' : ", awaiting the user's review"})`,
  )
  if (rows.length > MAX_LISTED_ACTIONS) listed.push(`- and ${rows.length - MAX_LISTED_ACTIONS} more: see \`list_actions\``)
  return [
    "Project actions, one-click buttons the user runs from Sillage's Actions menu (⚡) in the conversation header:",
    listed.join('\n'),
    "When the user says they ran one, read its latest run with `read_action_output` instead of running it again. When your work shows another command the user will want to rerun, propose it with `register_action` without waiting to be asked, at most once per session; if an action's command no longer matches the project, update it rather than adding a duplicate.",
  ].join('\n')
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

/**
 * Shared tool guidance, part of the stable overview: it names tools, not state. One clause per
 * capability, tagged with its family, so a disabled family drops out of the sentence; `null` for
 * always-on tools.
 */
const TOOL_CLAUSES: [AgentToolFamily | null, string][] = [
  ['history', '`search_history` and `read_conversation` for earlier decisions'],
  ['history', '`list_sessions` and `find_file_edits` for current work by others'],
  ['history', '`work_log` for time spent per day'],
  ['coordination', '`send_session_message` to alert or ask another session when it cannot wait for the user'],
  ['coordination', '`notify_when_done` to resume when it finishes instead of polling'],
  ['coordination', '`broadcast_session_message` before an action affecting all working sessions'],
  ['board', '`list_cards` and `read_card` for planned project work'],
  ['board', '`attach_card` when you start on a card this session is not attached to'],
  ['board', '`create_card` to record work outside your scope'],
  ['coordination', '`start_session` to delegate work to a new session when the user asks'],
  ['worktrees', '`list_worktrees`, `create_worktree` and `remove_worktree` to work separately from others and clean up after a merge instead of using `git worktree add` or `remove`, which Sillage would not track'],
  ['automations', '`schedule_task` to schedule recurring or deferred work that survives this session'],
  ['automations', '`create_automation` to start a session on webhook calls (a labeled issue or failed CI)'],
  ['actions', '`list_actions` and `register_action` for one-click project buttons that launch a server, tests or a script, and `read_action_output` to read a run, including one the user started'],
  [null, '`describe_preview` each time you start a dev server, to title it and name the page to open when it is for the user, or keep an API or worker out of the thread'],
  ['project', '`list_mcp_servers` and `install_mcp_server` to propose an MCP server the user confirms, typing any secret themselves'],
]

export function toolsGuidance(input: { families?: Families | null }): string | null {
  const clauses = TOOL_CLAUSES.filter(([family]) => family === null || on(input, family)).map(([, clause]) => clause)
  if (clauses.length === 0) return null
  const list = clauses.length === 1 ? clauses[0] : `${clauses.slice(0, -1).join(', ')}, and ${clauses.at(-1)}`
  return `The \`sillage\` server tools provide further context: ${list}.`
}

/** Kinds of work reachable in other projects, by family; memory always is. */
const CROSS_KINDS: [AgentToolFamily, string][] = [
  ['history', 'history'],
  ['coordination', 'sessions'],
  ['board', 'cards'],
  ['worktrees', 'worktrees'],
  ['actions', 'actions'],
  ['automations', 'schedules'],
  ['instructions', 'instructions'],
]

function crossProjectsReminder(input: OverviewInput): string {
  const kinds = [...CROSS_KINDS.filter(([family]) => on(input, family)).map(([, kind]) => kind), 'memory']
  const workLog = on(input, 'history') ? ', and `work_log` reports time spent per day and project' : ''
  const startHere = on(input, 'coordination') ? ' What you start or send there carries this project\'s name.' : ''
  return `This project lets its sessions act on the account's other projects. The \`sillage\` tools that accept \`project\` (${kinds.join(', ')}) work there by name or ID from list_projects${workLog}. Each project's own tool switches still apply there. When the user asks about another project, work on it from here with \`project\` rather than moving this session.${startHere}`
}

/**
 * Stable part of the startup context, sent as system prompt. State that moves (sessions, ages,
 * title, card, image) goes through `liveSessionContext`, sent with the first message of each
 * launch, for two reasons:
 * - opencode resends `system` with every message, ahead of the history: ages that changed each
 *   turn defeated the provider's prefix cache.
 * - Claude keeps the system prompt of its first launch on resume and ignores the new one (probed
 *   on CLI 2.1.318 and SDK 0.3.325, 24 Nov 2026), and Grok reads it only on creation: a list kept
 *   here stayed frozen at the first launch.
 * Settings the user changes (cross-project access, webhooks) may still change it: rare and wanted.
 */
export function projectOverview(db: Db, input: OverviewInput): string | null {
  if (!input.sillageMcp) return forgeMarkerReminder(db, input)
  const crossReminder = crossProjectsEnabled(db, input.projectId) ? crossProjectsReminder(input) : null
  return [
    `To cite a session in your replies, write session:<id> using its exact Sillage identifier: the interface turns it into a link with its title and details.${on(input, 'history') ? ' read_conversation accepts this identifier or reference to read the thread, including archives.' : ''} A mention alone is not a request to message another agent.`,
    on(input, 'coordination')
      ? 'If the task belongs to a different project, point out the mismatch. Once the user identifies the intended project, use list_projects and move_session to move this same session with its full history, then finish your turn so the move can take effect. The next turn uses the destination workspace and instructions; files and project memory stay in their original folders.'
      : null,
    crossReminder,
    on(input, 'project')
      ? "When your work creates a related experiment outside the project's main folder or regularly uses a related folder elsewhere, use attach_project_folder from a project owner's session so people can find it in Files. Attach the experiment's own directory. Use list_project_folders to see existing attachments."
      : null,
    forgeMarkerReminder(db, input),
    toolsGuidance(input),
  ].filter((part) => part !== null).join('\n\n')
}

/**
 * Moving state, sent once per CLI launch with the first message (see `projectOverview`).
 * `activity` is false when platform additions are disabled: only the title reminder remains,
 * which needs nothing but the `sillage` server. Null when empty: repeated empty notes teach
 * models to ignore them.
 */
export function liveSessionContext(
  db: Db,
  input: { projectId: string | null; conversationId: string; sillageMcp: boolean; activity: boolean; families?: Families | null },
): string | null {
  const project = input.activity && input.projectId ? { ...input, projectId: input.projectId } : null
  // Cards before images: requested work precedes suggestions.
  const parts = [
    sessionTitleReminder(db, input),
    input.sillageMcp ? disabledFamiliesNotice(input.families ?? null) : null,
    project ? cardBriefing(db, project) : null,
    project && on(input, 'project') ? imageReminder(db, project) : null,
    project && on(input, 'actions') ? actionsBriefing(db, project) : null,
    project ? sessionActivity(db, project) : null,
  ].filter((part) => part !== null)
  if (parts.length === 0) return null
  return ['Sillage context as this session (re)starts, current at this message:', ...parts].join('\n\n')
}

/** Neighboring sessions, the part of the overview that ages fastest. */
function sessionActivity(db: Db, input: OverviewInput): string | null {
  const now = Date.now()

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

  if (rows.length === 0) return null

  const working = rows.filter(
    (row) => row.status === 'running' || row.background > 0 || row.loops > 0,
  )

  const parts = [
    `Other Sillage sessions in this project, ${working.length > 0 ? `${working.length} currently working` : 'none currently working'}:`,
    rows.map((row) => describe(row, now)).join('\n'),
  ]

  if (working.length > 0) {
    parts.push(
      "An active session may be working in the same tree: before undoing a change you did not make, check where it came from.",
    )
  }

  return parts.join('\n\n')
}
