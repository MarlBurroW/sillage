import { useState } from 'react'
import type { TurnCheckpoint } from '../../lib/chat-fold'

/** Open state of the screen's dialogs, opened from the toolbar, the palette, the thread or the panel. */
export function useConversationDialogs() {
  const [usageOpen, setUsageOpen] = useState(false)
  /** Turn whose workspace changes are proposed for undo, or whose restoration is proposed for cancelling. */
  const [restoreTarget, setRestoreTarget] = useState<{ checkpoint: TurnCheckpoint; undo: boolean } | null>(null)
  const [metaOpen, setMetaOpen] = useState(false)
  const [createProjectOpen, setCreateProjectOpen] = useState(false)
  /** “Continue in another CLI” dialog: switching tools requires confirmation. */
  const [handoffOpen, setHandoffOpen] = useState(false)
  const [moveProjectOpen, setMoveProjectOpen] = useState(false)
  const [exportOpen, setExportOpen] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [instructionsOpen, setInstructionsOpen] = useState(false)
  const [cardLinkOpen, setCardLinkOpen] = useState(false)

  return {
    usageOpen,
    setUsageOpen,
    restoreTarget,
    setRestoreTarget,
    metaOpen,
    setMetaOpen,
    createProjectOpen,
    setCreateProjectOpen,
    handoffOpen,
    setHandoffOpen,
    moveProjectOpen,
    setMoveProjectOpen,
    exportOpen,
    setExportOpen,
    findOpen,
    setFindOpen,
    instructionsOpen,
    setInstructionsOpen,
    cardLinkOpen,
    setCardLinkOpen,
  }
}

export type ConversationDialogState = ReturnType<typeof useConversationDialogs>
