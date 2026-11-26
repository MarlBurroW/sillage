import { Link } from 'react-router-dom'
import {
  ArrowRightLeft,
  FileText,
  FlaskConical,
  FolderInput,
  FolderPlus,
  GaugeCircle,
  Info,
  Search,
  Share2,
  Shrink,
  SquareKanban,
} from 'lucide-react'
import { benchmarkPath, type ConversationDto, type ProjectDto, type WorktreeDto } from '@sillage/protocol'
import { ActionsLauncher } from '../../components/actions/ActionsLauncher'
import { AGENT_LABELS, AgentIcon } from '../../components/AgentIcon'
import { columnLabel } from '../../components/board/columns'
import { ConcentrationButton } from '../../components/chat/ConcentrationButton'
import { SignalRow } from '../../components/chat/Signals'
import { WorkspaceLabel } from '../../components/chat/WorkspaceLabel'
import { InstructionsButton } from '../../components/instructions/InstructionsPlace'
import { MobileNavigationButton } from '../../components/MobileNavigation'
import { PanelToggle } from '../../components/panel/PanelToggle'
import { TooltipProvider } from '../../components/ui/Tooltip'
import { IconButton, cx } from '../../components/ui'
import { useTranslate } from '../../lib/i18n'
import { setPanelOpen } from '../../lib/panel'
import type { Signal, SignalKind } from '../../lib/signals'
import type { ConversationDialogState } from './use-conversation-dialogs'

/** Header-retained states indicating that displayed content is no longer current. */
const HEADER_SIGNALS = new Set<SignalKind>(['error', 'interrupted', 'offline'])

/** The conversation's title row: agent, project, branch and card, then the toolbar and panel toggle. */
export function ConversationHeader({
  conversationId,
  conversation,
  project,
  worktree,
  worktreesLoaded,
  signals,
  concentration,
  isOwner,
  canCompact,
  compactBusy,
  canMove,
  idle,
  cardShown,
  showCard,
  compact,
  panelReplaced,
  dialogs,
}: {
  conversationId: string
  conversation: ConversationDto
  project: ProjectDto | undefined
  worktree: WorktreeDto | undefined
  worktreesLoaded: boolean
  signals: Signal[]
  concentration: boolean
  isOwner: boolean
  canCompact: boolean
  compactBusy: boolean
  canMove: boolean
  /** No turn is open: compaction is offered only then. */
  idle: boolean
  cardShown: boolean
  showCard: () => void
  compact: () => Promise<void>
  /** The docked panel already shows its own toggle in this spot. */
  panelReplaced: boolean
  dialogs: ConversationDialogState
}) {
  const t = useTranslate()

  return (
    <header
      className={cx(
        'surface sticky top-0 z-10 flex shrink-0 flex-wrap items-center gap-1.5',
        // `py-1` around 44px controls gives the panel header's height: the two rules meet
        // when the panel is docked, and the two panel toggles share one spot.
        'border-b border-line px-2 py-1 @min-[44rem]/thread:gap-3 @min-[44rem]/thread:px-4',
        // The show-navigation button occupies this corner: without reserved space,
        // it covers the CLI icon.
        concentration && 'sg-concentration-header',
      )}
    >
      {!concentration ? <MobileNavigationButton /> : null}
      <span
        role="img"
        aria-label={AGENT_LABELS[conversation.agent]}
        title={AGENT_LABELS[conversation.agent]}
        className="flex size-8 shrink-0 items-center justify-center"
      >
        <AgentIcon agent={conversation.agent} size={20} />
      </span>

      <div className="sg-conversation-heading min-w-0 flex-1">
        {/* Preserve project width; truncate the branch first. */}
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-ink-soft">
          {conversation.projectId ? <>
          <Link
            to={`/p/${conversation.projectId}`}
            className="max-w-[60%] shrink-0 truncate rounded-sm hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
          >
            {project?.name}
          </Link>
          {!conversation.worktreeId ? <WorkspaceLabel
            worktreeId={conversation.worktreeId}
            worktree={worktree}
            worktreesLoaded={worktreesLoaded}
            projectGit={project?.git}
            projectPath={project?.workspacePath}
          /> : null}
          {/*
           * The card sits with the project and branch: it names what the session is for.
           * Opening it in the panel keeps the thread in view, unlike leaving for the board.
           */}
          {conversation.card ? (
            <button
              type="button"
              onClick={showCard}
              title={t('conversation.card.open', { number: conversation.card.number, title: conversation.card.title, column: columnLabel(conversation.card.column) })}
              className="flex min-w-0 items-center gap-1 rounded-sm text-ink-soft hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
            >
              <SquareKanban size={12} className="shrink-0" />
              <span className="shrink-0 font-medium">#{conversation.card.number}</span>
              <span className="min-w-0 truncate">{conversation.card.title}</span>
            </button>
          ) : null}
          </> : conversation.benchmarkId ? (
            // A run belongs to its benchmark: lead back to the table rather than to Discussions.
            <Link to={benchmarkPath(conversation.benchmarkId)} className="flex min-w-0 items-center gap-1 text-ink-soft hover:text-ink">
              <FlaskConical size={12} className="shrink-0" />
              <span>{t('benchmark.runOf')}</span>
            </Link>
          ) : <span>{t('discussions.personal')}</span>}
        </div>
        <p className="truncate text-sm font-medium" title={conversation.title}>{conversation.title}</p>


      </div>

      {/*
       * The header retains only states invalidating the current reading: errors,
       * interrupted turns or disconnected links. Everything else lives above the composer,
       * visible alongside the header; repeating it would duplicate it.
       */}
      <SignalRow signals={signals.filter((signal) => HEADER_SIGNALS.has(signal.kind))} />

      {/*
       * Narrow threads keep full touch targets on a separate action row. `order-last` sends
       * that row below the panel toggle, which stays in the heading's corner.
       */}
      <TooltipProvider delayDuration={120}>
        <div className="order-last flex w-full shrink-0 items-center justify-start gap-0.5 overflow-x-auto @min-[56rem]/thread:order-none @min-[56rem]/thread:justify-end @min-[56rem]/thread:w-auto" data-conversation-toolbar>
          <IconButton label={t('conversation.usage.title')} onClick={() => dialogs.setUsageOpen(true)}>
            <GaugeCircle size={18} />
          </IconButton>
          {conversation.projectId ? <InstructionsButton projectId={conversation.projectId} onOpen={() => dialogs.setInstructionsOpen(true)} /> : (
            <IconButton label={t('discussions.context')} onClick={() => dialogs.setInstructionsOpen(true)}>
              <FileText size={18} />
            </IconButton>
          )}
          <IconButton label={t('conversation.search')} onClick={() => dialogs.setFindOpen(true)}>
            <Search size={18} />
          </IconButton>
          {isOwner && <IconButton label={t('export.title')} onClick={() => dialogs.setExportOpen(true)}>
            <Share2 size={18} />
          </IconButton>}
          {canCompact ? (
            <IconButton
              label={compactBusy
                ? t('conversation.compact.running')
                : t('conversation.compact.action')}
              // Summarizing during a turn would discard context still being changed.
              disabled={compactBusy || !idle}
              onClick={() => void compact()}
            >
              <Shrink size={18} />
            </IconButton>
          ) : null}
          <IconButton label={t('conversation.meta.details')} onClick={() => dialogs.setMetaOpen(true)}>
            <Info size={18} />
          </IconButton>
          {!conversation.projectId ? (
            <IconButton label={t('discussions.project.create')} onClick={() => dialogs.setCreateProjectOpen(true)}>
              <FolderPlus size={18} />
            </IconButton>
          ) : null}
          <IconButton label={t('conversation.handoff.menu')} onClick={() => dialogs.setHandoffOpen(true)}>
            <ArrowRightLeft size={18} />
          </IconButton>
          {canMove ? (
            <IconButton label={t('conversation.move.title')} onClick={() => dialogs.setMoveProjectOpen(true)}>
              <FolderInput size={18} />
            </IconButton>
          ) : null}
          {/*
           * Direct access to the card: with one, it toggles the panel's Card tab; without,
           * it attaches the session to one. Readers who cannot attach only see it with a card.
           */}
          {conversation.projectId && (conversation.card || isOwner) ? (
            <IconButton
              label={conversation.card
                ? t(cardShown ? 'conversation.card.hide' : 'conversation.card.show', { number: conversation.card.number })
                : t('conversation.card.link')}
              onClick={() => {
                if (!conversation.card) dialogs.setCardLinkOpen(true)
                else if (cardShown) setPanelOpen(false)
                else showCard()
              }}
            >
              <SquareKanban size={18} className={cx(cardShown && 'text-accent')} />
            </IconButton>
          ) : null}

          {conversation.projectId ? <ActionsLauncher projectId={conversation.projectId} conversationId={conversationId} /> : null}
          <ConcentrationButton />
        </div>
        {/*
         * Outside the scrolling row and last: the far right corner, where the panel opens,
         * whatever the width. The panel belongs to the conversation and reads this thread's
         * working directory, including its worktree, not the project's. The negative margins
         * leave 4px to the edge, as in the panel's header.
         */}
        <PanelToggle page replaced={panelReplaced} className="-mr-1 @min-[44rem]/thread:-mr-3" />
      </TooltipProvider>
    </header>
  )
}
