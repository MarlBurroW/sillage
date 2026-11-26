import {
  ArrowRightLeft,
  FileText,
  FolderInput,
  FolderPlus,
  GaugeCircle,
  Info,
  Search,
  Share2,
  Shrink,
  Square,
  SquareKanban,
} from 'lucide-react'
import type { ConversationDto, ConversationStatus } from '@sillage/protocol'
import { interruptConversation } from '../../lib/conversations'
import { useTranslate } from '../../lib/i18n'
import { usePublishSessionCommands } from '../../lib/session-commands'
import type { ConversationDialogState } from './use-conversation-dialogs'

/**
 * The toolbar's actions, offered to the search palette under the same conditions. Listed
 * here rather than derived from the buttons: several toggle or change label with state,
 * while a palette row names one action.
 *
 * A hook cannot follow the page's early return, so the published list is a rendered element.
 */
export function ConversationCommands({
  conversationId,
  conversation,
  status,
  isOwner,
  canCompact,
  compactBusy,
  canMove,
  turnOpen,
  compact,
  showCard,
  dialogs,
}: {
  conversationId: string
  conversation: ConversationDto
  status: ConversationStatus
  isOwner: boolean
  canCompact: boolean
  compactBusy: boolean
  canMove: boolean
  turnOpen: boolean
  compact: () => Promise<void>
  showCard: () => void
  dialogs: ConversationDialogState
}) {
  const t = useTranslate()
  usePublishSessionCommands([
    { key: 'find', label: t('conversation.search'), icon: <Search size={15} />, run: () => dialogs.setFindOpen(true) },
    ...(isOwner ? [{ key: 'export', label: t('export.title'), icon: <Share2 size={15} />, run: () => dialogs.setExportOpen(true) }] : []),
    // Summarizing during a turn would discard context still being changed.
    ...(canCompact && !compactBusy && status === 'idle'
      ? [{ key: 'compact', label: t('conversation.compact.action'), icon: <Shrink size={15} />, run: () => void compact() }]
      : []),
    ...(isOwner && turnOpen
      ? [{ key: 'interrupt', label: t('composer.interrupt'), icon: <Square size={13} />, run: () => void interruptConversation(conversationId) }]
      : []),
    { key: 'handoff', label: t('conversation.handoff.menu'), icon: <ArrowRightLeft size={15} />, run: () => dialogs.setHandoffOpen(true) },
    ...(canMove ? [{ key: 'move', label: t('conversation.move.title'), icon: <FolderInput size={15} />, run: () => dialogs.setMoveProjectOpen(true) }] : []),
    ...(!conversation.projectId
      ? [{ key: 'create-project', label: t('discussions.project.create'), icon: <FolderPlus size={15} />, run: () => dialogs.setCreateProjectOpen(true) }]
      : []),
    ...(conversation.card
      ? [{ key: 'card-show', label: t('conversation.card.show', { number: conversation.card.number }), icon: <SquareKanban size={15} />, run: showCard }]
      : []),
    { key: 'details', label: t('conversation.meta.details'), icon: <Info size={15} />, run: () => dialogs.setMetaOpen(true) },
    { key: 'usage', label: t('conversation.usage.title'), icon: <GaugeCircle size={15} />, run: () => dialogs.setUsageOpen(true) },
    { key: 'instructions', label: t(conversation.projectId ? 'search.session.instructions' : 'discussions.context'), icon: <FileText size={15} />, run: () => dialogs.setInstructionsOpen(true) },
  ])
  return null
}
