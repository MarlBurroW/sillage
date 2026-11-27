import { useState } from 'react'
import type { AgentConfig, ConversationDto } from '@sillage/protocol'
import type { BackgroundWork } from '../../../lib/background'
import { setPanelOpen, setPanelTab } from '../../../lib/panel'
import type { StatusItem } from '../../../lib/status-bar'
import { useStatusData } from '../../../lib/status-data'
import type { SubAgent } from '../../../lib/subagents'
import type { ChatStream } from '../../../lib/use-chat-stream'
import { StatusBar } from './StatusBar'
import { StatusBarSettings } from './StatusBarSettings'
import type { StatusPlace } from './pieces'

/** The status line of an open conversation: live values, and where each piece leads. */
export function ConversationStatusBar({ conversation, stream, config, runningSubAgents, background, items, onOpenUsage, onOpenDetails }: {
  conversation: ConversationDto
  stream: ChatStream
  config: AgentConfig | null
  runningSubAgents: SubAgent[]
  background: BackgroundWork[]
  items: StatusItem[]
  onOpenUsage: () => void
  onOpenDetails: () => void
}) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const data = useStatusData({ conversation, stream, config, runningSubAgents, background, items })
  const open = (place: StatusPlace) => {
    if (place === 'usage') onOpenUsage()
    else if (place === 'details') onOpenDetails()
    else {
      setPanelTab(place)
      setPanelOpen(true)
    }
  }
  return (
    <>
      <StatusBar items={items} data={data} onConfigure={() => setSettingsOpen(true)} onOpen={open} />
      <StatusBarSettings open={settingsOpen} onOpenChange={setSettingsOpen} agent={conversation.agent} />
    </>
  )
}
