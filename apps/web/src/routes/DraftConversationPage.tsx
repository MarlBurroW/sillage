import { conversationPath } from '@sillage/protocol'
import { EyeOff, History, PanelRight, SquareKanban, X } from 'lucide-react'
import { Suspense, lazy, useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  AGENT_CAPABILITIES,
  agentKindSchema,
  cardBranchName,
  defaultConfigFor,
  type AgentConfig,
  type AgentKind,
  type AgentAvailabilityDto,
} from '@sillage/protocol'
import type { AgentSkillDto, McpServerStatus, SlashCommandDto } from '@sillage/protocol'
import { AGENT_LABELS, AGENT_META, AgentIcon } from '../components/AgentIcon'
import { AgentInstallProgress } from '../components/AgentInstallProgress'
import { Composer } from '../components/chat/Composer'
import { AccountChoice } from '../components/chat/AccountChoice'
import { MobileNavigationButton } from '../components/MobileNavigation'
import { UsageBar, readAge } from '../components/chat/UsageBar'
import { Banner, Button, IconButton, cx } from '../components/ui'
import { WorktreeSelect } from '../components/WorktreeSelect'
import { useCards } from '../lib/cards'
import {
  hiddenAgent,
  useAgentAvailability,
  useAgentInstall,
  useHiddenAgents,
  unavailableReason,
  versionMismatch,
} from '../lib/agents'
import { useCliSessions, useImportCliSession } from '../lib/claude-sessions'
import { useProjectCommands } from '../lib/commands'
import { useFileDrop } from '../lib/file-drop'
import { useAllConversations, useCreateConversation } from '../lib/conversations'
import { useProjects } from '../lib/projects'
import { useRememberProjectView } from '../lib/project-view'
import { locale, useTranslate } from '../lib/i18n'
import { setPanelOpen, usePanelPresence } from '../lib/panel'
import { useSidebarHidden } from '../lib/sidebar'
import { useAgentUsage, usageAccountOf } from '../lib/usage'
import { useUserSettings } from '../lib/user-settings'
import { uuidv4 } from '../lib/uuid'
import { ActionsLauncher } from '../components/actions/ActionsLauncher'

const SidePanel = lazy(() =>
  import('../components/panel/SidePanel').then((m) => ({ default: m.SidePanel })),
)

/** Choice cards follow the protocol enum: newly added CLIs appear automatically. */
const AGENTS = agentKindSchema.options.map((value) => ({ value, ...AGENT_META[value] }))

/** Short date and time: enough to locate a session without consuming the row. */
function formatDay(ts: number): string {
  return new Date(ts).toLocaleString(locale(), {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * Selected CLI usage before writing anything.
 *
 * The choice is still open here: seeing a window at 95% avoids discovering it mid-turn. Uses
 * the detailed panel's query; the five-minute server cache prevents every draft opening from
 * starting a CLI.
 *
 * Display nothing until there is something to show: no skeleton or empty frame. Cold probes
 * take several seconds, and the draft primarily exists for typing, not watching gauges appear.
 */
function DraftUsage({
  agent,
  account,
  enabled,
}: {
  agent: AgentKind
  account: string | null
  enabled: boolean
}) {
  const t = useTranslate()
  const { data: usage, error } = useAgentUsage(agent, enabled, account)

  // Usage is secondary here: one line suffices when probing fails, whereas an error
  // banner would overshadow the form.
  if (error) return <p className="text-xs text-ink-faint">{t('draft.usage.unavailable')}</p>
  // Additional account without a gauge: the user just chose based on usage, so silent
  // absence would look broken. Explain the reason below its option.
  if (!usage || !usage.limitsAvailable || usage.windows.length === 0) return null

  return (
    <section className="flex flex-col gap-2.5 rounded-lg border border-line px-3 py-3 text-xs text-ink-soft">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium">
          {usage.plan
            ? t('draft.usage.titleWithPlan', { plan: usage.plan })
            : t('draft.usage.title')}
        </span>
        <span className="text-[0.6875rem] text-ink-faint">
          {t('usage.readAt', { age: readAge(usage.fetchedAt) })}
        </span>
      </div>
      {usage.windows.map((window) => (
        <UsageBar key={window.id} window={window} />
      ))}
    </section>
  )
}

/**
 * Conversation not yet created.
 *
 * Nothing is written to the database until a message is sent: clicking “+” must not leave an
 * empty, untitled thread. Creation and first message are submitted together, and the first turn
 * supplies the title.
 */
const NO_MCP_INVENTORY: McpServerStatus[] = []
const NO_COMMANDS: SlashCommandDto[] = []
const NO_SKILLS: AgentSkillDto[] = []

/**
 * Missing CLI: availability, install button and option to stop suggesting it. During
 * installation, the row becomes its progress display.
 */
function InstallRow({ entry, onDismiss }: { entry: AgentAvailabilityDto; onDismiss: () => void }) {
  const t = useTranslate()
  const label = AGENT_LABELS[entry.agent]
  const install = useAgentInstall(entry, label)
  if (install.progress) {
    return (
      <div className="rounded-lg border border-line p-3">
        <AgentInstallProgress label={label} version={entry.preferredVersion} progress={install.progress} />
      </div>
    )
  }
  return (
    <div className="flex items-center justify-between gap-2 rounded-lg border border-line p-2">
      <span className="min-w-0 text-xs leading-snug text-ink-faint">{install.status}</span>
      <span className="flex shrink-0 items-center gap-1">
        <Button size="sm" variant="secondary" disabled={install.busy} onClick={install.start}>
          {install.action}
        </Button>
        <IconButton label={t('agent.install.dismiss')} size="sm" onClick={onDismiss}>
          <EyeOff size={14} />
        </IconButton>
      </span>
    </div>
  )
}

export function DraftConversationPage() {
  const { projectId } = useParams()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { data: conversations } = useAllConversations()
  const createConversation = useCreateConversation(projectId ?? null)
  const sidebarHidden = useSidebarHidden()
  const panel = usePanelPresence()

  // Initial value only: the CLI remains editable until sending.
  // Otherwise sidebar “+” would lock the draft to the last thread's CLI.
  const requested = agentKindSchema.safeParse(params.get('agent'))
  const suggested: AgentKind = requested.success
    ? requested.data
    : (conversations?.find((c) => c.projectId === (projectId ?? null))?.agent ?? 'claude')

  const [chosenAgent, setChosenAgent] = useState<AgentKind | null>(null)
  const { data: availability } = useAgentAvailability()
  const t = useTranslate()
  // Account-hidden CLIs are neither offered for installation nor selectable while
  // missing: Claude-only users should not have to skip past them.
  const hiddenAgents = useHiddenAgents()
  const hiddenRows = (availability?.agents ?? []).filter(
    (entry) => entry.reason !== 'disabled' && hiddenAgent(entry, hiddenAgents.hidden),
  )

  // Suggested CLI falls back to an installed one. Otherwise the form would open on
  // a disabled card yet still allow sending, since disabling only blocks clicks:
  // the default is “claude” or the project's last-thread CLI, neither of which
  // knows what is actually installed.
  //
  // Never replace an explicit choice, whether a click or URL `?agent=`:
  // switching under someone who just selected a CLI would be worse
  // than letting them see it is missing.
  const installed = (kind: AgentKind) =>
    availability?.agents.find((a) => a.agent === kind)?.installed !== false
  const fallback = availability?.agents.find((a) => a.installed)?.agent
  const agent =
    chosenAgent ?? (requested.success || installed(suggested) ? suggested : (fallback ?? suggested))

  const selectedAvailability = availability?.agents.find((a) => a.agent === agent)
  const blocked = unavailableReason(selectedAvailability)
  const selectedVersionNotice = versionMismatch(selectedAvailability)

  // Arriving from the board does not count: neither a card launch carrying its
  // reference nor the board's explicitly marked new-conversation button.
  const location = useLocation()
  const fromBoard =
    params.get('card') !== null || (location.state as { from?: string } | null)?.from === 'board'
  useRememberProjectView(projectId, fromBoard ? null : 'draft')

  const [config, setConfig] = useState<AgentConfig | null>(null)
  const { data: projects } = useProjects()
  const project = projects?.find((p) => p.id === projectId)

  // The board opens this draft with its card. Nothing is associated until sending:
  // this is an initial value like the CLI, and the badge can be removed.
  const [detached, setDetached] = useState(false)
  const { data: cards } = useCards(projectId)
  const requestedCard = projectId ? params.get('card') : null
  const card = detached ? undefined : cards?.find((entry) => entry.id === requestedCard)
  /**
   * The composer reads initial text only at mount. Rendering before the card is known would
   * freeze it without the mention; assigning it later would do nothing. Wait for the response
   * rather than remounting and losing text typed meanwhile.
   */
  const cardPending = Boolean(requestedCard) && !detached && cards === undefined

  // Worktree already associated with the card, if any: resuming work should land in
  // the right tree automatically. Most recent wins, since the card may have
  // changed branches along the way.
  const cardWorktree = card?.conversations.findLast((session) => session.worktreeId)?.worktreeId
  const [worktreeId, setWorktreeId] = useState<string | null>(null)
  const [worktreeTouched, setWorktreeTouched] = useState(false)
  const effectiveWorktreeId = projectId ? worktreeTouched ? worktreeId : (cardWorktree ?? worktreeId) : null

  // Project preset first, then account defaults: project-specific MCP servers and
  // extra directories describe that project more precisely than universal account
  // defaults. Use protocol defaults until loading completes: they are only a
  // temporary starting point during the round trip, and nothing is sent before
  // the first message.
  const { data: userSettings } = useUserSettings()
  const defaults =
    project?.defaultConfig[agent] ?? userSettings?.agentDefaults[agent] ?? defaultConfigFor(agent)
  // Claude configuration is meaningless for Codex: discard it when the CLI changes
  // rather than retaining it for server rejection.
  const effective = useMemo(
    () => (config?.agent === agent ? config : defaults),
    [config, agent, defaults],
  )

  // Load only when the selected CLI persists readable local sessions.
  // A worktree hides the list: these sessions live in the project root.
  const { data: cliSessions, error: cliSessionsError } = useCliSessions(
    projectId,
    AGENT_CAPABILITIES[agent].cliSessions && !effectiveWorktreeId && Boolean(project && userSettings) && availability !== undefined && blocked === null,
    agent,
    effective.agent !== 'opencode' ? effective.account : null,
  )
  const cliSessionList = effectiveWorktreeId ? [] : (cliSessions?.sessions ?? [])
  const importSession = useImportCliSession(projectId ?? '', agent, effective.agent !== 'opencode' ? effective.account : null)

  // Selected CLI's slash commands, read in the target directory: otherwise typing
  // `/` here showed nothing until after the first turn.
  //
  // Wait until installation is known (`blocked` is also null before availability
  // loads) and the directory is known: a card may specify a worktree, so probing
  // the root meanwhile would launch a CLI needlessly. The composer is not
  // rendered yet anyway.
  const { data: projectCommands, error: commandsError } = useProjectCommands(
    projectId,
    agent,
    effectiveWorktreeId,
    AGENT_CAPABILITIES[agent].draftCommands &&
      availability !== undefined &&
      blocked === null &&
      !cardPending,
    effective.agent === 'antigravity' ? effective.account : null,
  )

  const importAndOpen = async (sessionId: string) => {
    const created = await importSession.mutateAsync(sessionId)
    navigate(conversationPath(created), { replace: true })
  }

  // Drop handling follows composer state: without it (card loading) or without a CLI,
  // files have nowhere to go.
  const drop = useFileDrop(!cardPending && blocked === null)

  const send = async (
    text: string,
    attachmentIds: string[],
    mentions: string[],
    skills: string[],
  ) => {
    const created = await createConversation.mutateAsync({
      agent,
      config: effective,
      worktreeId: effectiveWorktreeId,
      cardId: card?.id ?? null,
      // Use the card title rather than a message excerpt: the conversation handles named
      // work, and the CLI need not suggest a title.
      title: card?.title,
      firstMessage: { clientMessageId: uuidv4(), text, attachmentIds, mentions, skills },
    })

    // `replace`: going back must not return to a draft that no longer
    // has a purpose.
    navigate(conversationPath(created), { replace: true })
  }

  return (
    // `relative`: this container anchors the absolutely positioned side panel.
    <div className="relative flex h-full flex-col overflow-clip pb-safe" {...drop.handlers}>
      {/*
       * Same drop overlay as conversations: the composer already handles drops; it only needed
       * an area forwarding them.
       */}
      {drop.dragging ? (
        <div
          className={cx(
            'pointer-events-none absolute inset-2 z-30 flex items-center justify-center',
            'rounded-xl border-2 border-dashed border-accent bg-canvas/80 text-sm text-accent',
          )}
        >
          {t('conversation.drop.attach')}
        </div>
      ) : null}
      <header
        className={cx(
          'flex shrink-0 items-center gap-2 border-b border-line px-2 py-2',
          // Space reserved for the show-navigation button in this corner when the
          // sidebar is collapsed.
          sidebarHidden && 'md:pl-14',
        )}
      >
        <MobileNavigationButton />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{t(projectId ? 'draft.title' : 'discussions.new')}</p>
          <div className="flex items-center gap-1.5 text-[0.6875rem] text-ink-faint">
            <AgentIcon agent={agent} size={11} />
            <span>{project?.name ?? t('discussions.personal')}</span>
          </div>
        </div>
        {/*
         * Board access from the draft: this is where users choose what to work on, and cards
         * answer that question. The link is needed when opening a conversation before choosing
         * a work item.
         */}
        {projectId ? (
          <Button
            variant="ghost"
            size="sm"
            icon={<SquareKanban size={15} />}
            onClick={() => navigate(`/p/${projectId}/board`)}
          >
            {t('draft.board')}
          </Button>
        ) : null}
        {/*
         * The panel uses the project workspace: open terminals, files or diffs before any
         * session exists.
         */}
        {projectId ? <ActionsLauncher projectId={projectId} size="sm" /> : null}
        {projectId ? (
          <IconButton
            label={panel.open ? t('conversation.panel.close') : t('conversation.panel.open')}
            size="sm"
            onClick={() => setPanelOpen(!panel.open)}
          >
            <PanelRight size={16} className={cx(panel.open && 'text-accent')} />
          </IconButton>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex sg-conversation-width flex-col gap-4 px-4 py-6 md:py-10">
          <div className="mb-2 flex flex-col gap-1">
            <h1 className="text-xl font-semibold tracking-tight">{t(projectId ? 'draft.title' : 'discussions.new')}</h1>
            <p className="text-sm text-ink-faint">{t(projectId ? 'draft.subtitle' : 'discussions.description')}</p>
          </div>

          {/* Native radio buttons: compact selection with arrow-key navigation. */}
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-xs font-medium text-ink-soft">{t('draft.cli.legend')}</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {AGENTS.filter((option) => !hiddenRows.some((entry) => entry.agent === option.value)).map((option) => {
                const selected = option.value === agent
                const entry = availability?.agents.find((a) => a.agent === option.value)
                // Unavailable only after server confirmation. While probing, the card remains
                // active: disabling by default would flash on every opening and block valid
                // choices if the route
                // failed.
                const unavailable = unavailableReason(entry)
                return (
                  <label
                    key={option.value}
                    title={unavailable ?? option.blurb}
                    className={cx(
                      'flex min-h-11 items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors has-focus-visible:ring-2 has-focus-visible:ring-accent',
                      unavailable
                        ? 'cursor-not-allowed border-line bg-surface-high opacity-60'
                        : selected
                          ? 'border-accent bg-accent-wash'
                          : 'border-line hover:border-line-strong hover:bg-surface-high',
                    )}
                  >
                    <input type="radio" name="draft-agent" value={option.value}
                      aria-label={AGENT_LABELS[option.value]}
                      checked={selected} disabled={unavailable !== null}
                      onChange={() => setChosenAgent(option.value)}
                      className="size-3.5 shrink-0 accent-[var(--sg-accent)]" />
                    <AgentIcon agent={option.value} size={16} />
                    <span className="min-w-0 text-sm font-medium text-ink">
                      {AGENT_LABELS[option.value]}
                      {unavailable ? <span className="mt-0.5 block text-xs font-normal text-ink-faint">{unavailable}</span> : null}
                    </span>
                  </label>
                )
              })}
            </div>
            {selectedVersionNotice ? <p className="text-xs text-caution">{selectedVersionNotice}</p> : null}
            {/*
             * No installed CLI, or `?agent=` naming a missing one: options alone would not
             * explain why the composer refuses input.
             */}
            {blocked ? <Banner>{blocked}</Banner> : null}

            {/*
             * One row per missing CLI. Disabled CLIs are a configuration issue; installation
             * would not resolve their unavailability.
             */}
            {availability?.agents
              .filter((entry) => !entry.installed && entry.reason !== 'disabled' && !hiddenAgent(entry, hiddenAgents.hidden))
              .map((entry) => (
                <InstallRow key={entry.agent} entry={entry} onDismiss={() => hiddenAgents.hide(entry.agent)} />
              ))}
            {/*
             * A subtle row restores hidden choices: hiding is not configuration and should not
             * require visiting settings.
             */}
            {hiddenRows.length > 0 ? (
              <p className="text-xs text-ink-faint">
                {t('agent.install.hidden', { labels: hiddenRows.map((entry) => AGENT_LABELS[entry.agent]).join(', ') })}{' '}
                <button type="button" className="underline hover:text-ink" onClick={hiddenAgents.reveal}>
                  {t('agent.install.reveal')}
                </button>
              </p>
            ) : null}
          </fieldset>

          {/* Directly below the CLI: the same question, what the session starts with. */}
          <AccountChoice config={effective} onChange={setConfig} enabled={blocked === null} />

          {/*
           * A probe 502 means the CLI did not answer; hiding it would imply this directory
           * simply has no commands.
           */}
          {commandsError ? (
            <p className="text-xs text-ink-faint">{t('draft.commands.unavailable')}</p>
          ) : null}

          {card ? (
            <div className="flex items-center gap-2 rounded-md border border-line bg-sunken px-3 py-2">
              <span className="text-xs font-medium text-ink-faint">#{card.number}</span>
              <span className="min-w-0 flex-1 truncate text-sm text-ink-soft">{card.title}</span>
              <IconButton label={t('draft.card.detach')} onClick={() => setDetached(true)}>
                <X size={14} />
              </IconButton>
            </div>
          ) : null}

          {projectId ? (
            <WorktreeSelect
              projectId={projectId}
              value={effectiveWorktreeId}
              onChange={(next) => {
                setWorktreeTouched(true)
                setWorktreeId(next)
              }}
              isRepository={project?.git !== null && project !== undefined}
              suggestedName={card ? cardBranchName(card.number, card.title) : undefined}
            />
          ) : null}

          {cardPending ? null : (
            <Composer
              variant="draft"
              // An uncreated conversation's draft belongs to its project: the only thread we can
              // identify before it exists. Keep one draft per card, otherwise the free-form
              // creation draft would overwrite the card mention inserted here.
              draftKey={card ? `new:${projectId ?? ''}:card:${card.id}` : `new:${projectId ?? ''}`}
              // A sentence rather than just the number: a CLI unaware of the card has already
              // interpreted bare “#5” as the fifth item in a list.
              initialText={card ? `${t('draft.card.prompt', { number: card.number })} ` : ''}
              config={effective}
              // Nothing has launched: no CLI has MCP inventory or skills to report; these arrive
              // on the first turn. Slash commands can be read without a session where supported
              // (`draftCommands`). The composer filters Sillage-executed commands (`/compact`):
              // without a thread, there is no
              // plumbing to support them.
              mcpInventory={NO_MCP_INVENTORY}
              commands={projectCommands?.commands ?? NO_COMMANDS}
              skills={NO_SKILLS}
              status="idle"
              // Missing CLIs cannot be recovered server-side: the turn would fail after creation,
              // leaving an empty thread and a lost message.
              disabled={createConversation.isPending || blocked !== null}
              onSend={send}
              onInterrupt={() => {}}
              onConfigChange={setConfig}
              projectId={projectId ?? null}
              worktreeId={effectiveWorktreeId}
            />
          )}

          <DraftUsage agent={agent} account={usageAccountOf(effective)} enabled={blocked === null} />

          {/*
           * CLI-started sessions in this directory can be adopted instead of creating a
           * conversation. Import copies nothing; the same session remains resumable with
           * `claude --resume`.
           */}
          {/*
           * Report a failed list load: otherwise the error looks indistinguishable from “no
           * sessions”.
           */}
          {AGENT_CAPABILITIES[agent].cliSessions && !effectiveWorktreeId && cliSessionsError ? (
            <Banner>
              {cliSessionsError instanceof Error
                ? cliSessionsError.message
                : t('draft.cliSessions.error')}
            </Banner>
          ) : null}
          {AGENT_CAPABILITIES[agent].cliSessions && cliSessionList.length > 0 ? (
            <details className="rounded-lg border border-line px-3 pb-2">
              <summary className="cursor-pointer py-3 text-xs font-medium text-ink-soft">
                {t('draft.cliSessions.title', { label: AGENT_LABELS[agent] })}
              </summary>
              <p className="mb-2 text-xs leading-snug text-ink-faint">
                {t('draft.cliSessions.description')}
              </p>
              <div className="flex max-h-72 flex-col gap-1.5 overflow-y-auto">
                {cliSessionList.map((session) => (
                  <button
                    key={session.sessionId}
                    type="button"
                    disabled={importSession.isPending}
                    onClick={() => void importAndOpen(session.sessionId)}
                    className="flex items-center gap-2.5 rounded-md border border-line px-3 py-2 text-left transition-colors hover:border-line-strong hover:bg-surface-high disabled:opacity-60"
                  >
                    <History size={15} className="shrink-0 text-ink-faint" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-ink">{session.title}</span>
                      {session.firstPrompt && session.firstPrompt !== session.title ? (
                        <span className="block truncate text-xs text-ink-faint">
                          {session.firstPrompt}
                        </span>
                      ) : null}
                    </span>
                    <span className="shrink-0 text-right text-[0.6875rem] leading-tight text-ink-faint">
                      <time dateTime={new Date(session.lastModified).toISOString()}>
                        {formatDay(session.lastModified)}
                      </time>
                      {session.gitBranch ? (
                        <span className="block max-w-32 truncate">{session.gitBranch}</span>
                      ) : null}
                    </span>
                  </button>
                ))}
              </div>
              {importSession.isError ? (
                <Banner>
                  {importSession.error instanceof Error
                    ? importSession.error.message
                    : t('draft.import.error')}
                </Banner>
              ) : null}
            </details>
          ) : null}
        </div>
      </div>

      {projectId && panel.mounted ? (
        <Suspense fallback={null}>
          <SidePanel projectId={projectId} open={panel.open} />
        </Suspense>
      ) : null}
    </div>
  )
}
