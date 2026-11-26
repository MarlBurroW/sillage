import { Suspense } from 'react'
import type { ConversationDto, WorktreeDto } from '@sillage/protocol'
import type { BackgroundWork } from '../../lib/background'
import { useSetConversationCard } from '../../lib/conversations'
import { lazyWithReload } from '../../lib/lazy-reload'
import type { usePanelLayout, usePanelPresence } from '../../lib/panel'
import type { SubAgent } from '../../lib/subagents'
import type { ChatStream } from '../../lib/use-chat-stream'
import type { workflowTasksByToolCall } from '../../lib/workflows'

/**
 * Lazy-loaded: the editor bundles CodeMirror, and including it initially would charge every
 * conversation opening for a panel users may never open.
 */
const SidePanel = lazyWithReload(() =>
  import('../../components/panel/SidePanel').then((m) => ({ default: m.SidePanel })),
)

/** The conversation's side panel, fed with this thread's workspace, history and running work. */
export function ConversationSidePanel({
  conversationId,
  conversation,
  worktree,
  stream,
  isOwner,
  subAgents,
  background,
  workflowTasks,
  panel,
  panelLayout,
  onChangeCard,
}: {
  conversationId: string
  conversation: ConversationDto
  worktree: WorktreeDto | undefined
  stream: ChatStream
  isOwner: boolean
  subAgents: SubAgent[]
  background: BackgroundWork[]
  workflowTasks: ReturnType<typeof workflowTasksByToolCall>
  panel: ReturnType<typeof usePanelPresence>
  panelLayout: ReturnType<typeof usePanelLayout>
  onChangeCard: () => void
}) {
  const setConversationCard = useSetConversationCard()

  // Mounted through the exit animation: `panel.open` is the target state; `panel.mounted`
  // controls document presence. No loading overlay: show the panel once its code loads
  // instead of flashing an empty column.
  return panel.mounted ? (
    <Suspense fallback={null}>
      <SidePanel
        projectId={conversation.projectId}
        conversationId={conversationId}
        worktreePath={worktree?.path}
        workspaceName={conversation.worktreeId ? (worktree?.name ?? '…') : undefined}
        agent={conversation.agent}
        editTurns={stream.state.editTurns}
        history={{ hasMore: stream.hasMore, loading: stream.loadingOlder, load: stream.loadOlder }}
        checkpoints={stream.state.checkpoints}
        canRestore={isOwner && !stream.state.turnRunning}
        turnRunning={stream.state.turnRunning}
        subAgents={subAgents}
        background={background}
        workflows={workflowTasks}
        mcpServers={stream.state.mcp}
        cardId={conversation.card?.id ?? null}
        cardActions={isOwner ? {
          change: onChangeCard,
          detach: () => setConversationCard.mutate({ id: conversation.id, cardId: null }),
          detaching: setConversationCard.isPending,
        } : undefined}
        open={panel.open}
        docked={panelLayout.docked}
        canDock={panelLayout.canDock}
      />
    </Suspense>
  ) : null
}
