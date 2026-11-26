import { Suspense } from 'react'
import type { AgentConfig, ClaudeAccountDto, ConversationDto, HandoffDto, WorktreeDto } from '@sillage/protocol'
import type { ChatState } from '@sillage/protocol/chat-state'
import { CardLinkDialog } from '../../components/chat/CardLinkDialog'
import { CreateProjectDialog } from '../../components/chat/CreateProjectDialog'
import { HandoffDialog } from '../../components/chat/HandoffDialog'
import { MoveProjectDialog } from '../../components/chat/MoveProjectDialog'
import { RestoreCheckpointDialog } from '../../components/chat/RestoreCheckpointDialog'
import { UsagePanel } from '../../components/chat/UsagePanel'
import { InstructionsDialog } from '../../components/instructions/Instructions'
import { ConfirmDialog } from '../../components/ui'
import type { MessageItem } from '../../lib/chat-fold'
import { useTranslate } from '../../lib/i18n'
import { lazyWithReload } from '../../lib/lazy-reload'
import { usageAccountOf } from '../../lib/usage'
import { ConversationDetailsDialog } from './ConversationDetailsDialog'
import type { ConversationDialogState } from './use-conversation-dialogs'

const ExportDialog = lazyWithReload(() => import('../../components/chat/ExportDialog'))

/** Every dialog the conversation screen opens, in their original document order. */
export function ConversationDialogs({
  conversationId,
  conversation,
  config,
  isOwner,
  state,
  worktree,
  origin,
  continued,
  handoff,
  billingAccount,
  showCard,
  forking,
  forkTarget,
  setForkTarget,
  fork,
  dialogs,
}: {
  conversationId: string
  conversation: ConversationDto
  config: AgentConfig
  isOwner: boolean
  state: ChatState
  worktree: WorktreeDto | undefined
  origin: ConversationDto | undefined
  continued: ConversationDto | undefined
  handoff: HandoffDto | undefined
  billingAccount: ClaudeAccountDto | null | undefined
  showCard: () => void
  forking: boolean
  forkTarget: MessageItem | null
  setForkTarget: (target: MessageItem | null) => void
  fork: (message: MessageItem) => Promise<void>
  dialogs: ConversationDialogState
}) {
  const t = useTranslate()
  const { restoreTarget, setRestoreTarget } = dialogs

  return (
    <>
      {conversation.projectId && isOwner ? (
        <CardLinkDialog
          conversation={{ ...conversation, projectId: conversation.projectId }}
          open={dialogs.cardLinkOpen}
          onClose={() => dialogs.setCardLinkOpen(false)}
          onLinked={showCard}
        />
      ) : null}
      <InstructionsDialog
        open={dialogs.instructionsOpen}
        onOpenChange={dialogs.setInstructionsOpen}
        projectId={conversation.projectId}
      />
      <ConversationDetailsDialog
        open={dialogs.metaOpen}
        onOpenChange={dialogs.setMetaOpen}
        conversation={conversation}
        state={state}
        worktree={worktree}
        origin={origin}
        continued={continued}
        handoff={handoff}
        billingAccount={billingAccount}
      />

      <UsagePanel agent={conversation.agent} account={usageAccountOf(config)} open={dialogs.usageOpen} onOpenChange={dialogs.setUsageOpen} />

      <RestoreCheckpointDialog
        conversationId={conversationId}
        checkpoint={restoreTarget?.checkpoint ?? null}
        undo={restoreTarget?.undo ?? false}
        openerText={restoreTarget?.checkpoint.openerText ?? ''}
        onClose={() => setRestoreTarget(null)}
      />

      <ConfirmDialog
        open={forkTarget !== null}
        onOpenChange={(next) => {
          if (!next) setForkTarget(null)
        }}
        title={t('conversation.fork.confirm.title')}
        confirmLabel={t('conversation.fork.confirm.action')}
        busy={forking}
        onConfirm={() => {
          if (forkTarget) void fork(forkTarget)
        }}
      >
        <p>
          {t('conversation.fork.confirm.before')} <em>{t('conversation.fork.confirm.emphasis')}</em>
          {t('conversation.fork.confirm.after')}
        </p>
        <p>{t('conversation.fork.confirm.unaffected')}</p>
      </ConfirmDialog>

      {dialogs.createProjectOpen ? <CreateProjectDialog source={conversation} onOpenChange={dialogs.setCreateProjectOpen} /> : null}
      {dialogs.handoffOpen ? (
        <HandoffDialog open={dialogs.handoffOpen} onOpenChange={dialogs.setHandoffOpen} source={conversation} />
      ) : null}
      {dialogs.moveProjectOpen ? <MoveProjectDialog source={conversation} onClose={() => dialogs.setMoveProjectOpen(false)} /> : null}
      {dialogs.exportOpen && <Suspense fallback={null}><ExportDialog source={conversation} onClose={() => dialogs.setExportOpen(false)} /></Suspense>}
    </>
  )
}
