import { ArrowLeft, Bot } from 'lucide-react'
import { useMemo } from 'react'
import type { ChatItem } from '../../lib/chat-fold'
import { clearSubAgent, showSubAgent } from '../../lib/panel'
import { subAgentLabel, type SubAgent } from '../../lib/subagents'
import { buildRows } from '../../lib/tool-rows'
import { ChatThread } from '../chat/ChatThread'
import { SubAgentRow } from '../chat/SubAgentRow'
import { EmptyState, cx } from '../ui'

/**
 * Les sous-agents de la conversation : la liste, et le fil de celui qu'on consulte.
 *
 * Le fil est rendu par le même composant que le fil principal. Un sous-agent est une
 * conversation comme une autre, avec ses messages, sa réflexion et ses appels : lui
 * donner un rendu à part obligerait à tenir deux vues en accord pour un seul contenu.
 */
export function AgentsPane({
  conversationId,
  agents,
  selectedId,
  canDecide,
}: {
  conversationId: string
  agents: SubAgent[]
  selectedId: string | null
  canDecide: boolean
}) {
  const selected = agents.find((agent) => agent.id === selectedId) ?? null

  if (selected) {
    return (
      <SubAgentThread
        conversationId={conversationId}
        agent={selected}
        canDecide={canDecide}
        onBack={clearSubAgent}
      />
    )
  }

  if (agents.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center p-4">
        <EmptyState
          title="Aucun sous-agent"
          description="Les agents lancés par la conversation apparaîtront ici, avec leur fil complet."
        />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
      {agents.map((agent) => (
        <div key={agent.id} className={cx(agent.parentId && 'pl-3')}>
          <SubAgentRow agent={agent} onSelect={() => showSubAgent(agent.id)} />
        </div>
      ))}
    </div>
  )
}

function SubAgentThread({
  conversationId,
  agent,
  canDecide,
  onBack,
}: {
  conversationId: string
  agent: SubAgent
  canDecide: boolean
  onBack: () => void
}) {
  const rows = useMemo(() => buildRows(agent.items, agent.id), [agent.items, agent.id])

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-2 py-1.5">
        <button
          type="button"
          onClick={onBack}
          aria-label="Revenir à la liste des sous-agents"
          className="flex size-7 shrink-0 items-center justify-center rounded-md text-ink-faint hover:text-ink"
        >
          <ArrowLeft size={15} />
        </button>
        <Bot size={14} className={cx('shrink-0', agent.status === 'running' ? 'text-accent' : 'text-ink-faint')} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-ink">{subAgentLabel(agent)}</span>
          <span className="block truncate text-[0.6875rem] text-ink-faint">
            {agent.activity ? `${agent.type} · ${agent.activity}` : agent.type}
          </span>
        </span>
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {rows.length === 0 ? (
          <p className="text-xs text-ink-faint">
            {/* Le CLI transmet le travail du sous-agent au fil de l'eau : entre le
                lancement et son premier mot, il n'y a rien à montrer. */}
            {agent.status === 'running'
              ? 'Le sous-agent démarre...'
              : "Ce sous-agent n'a rien transmis."}
          </p>
        ) : (
          <ChatThread rows={rows} conversationId={conversationId} canDecide={canDecide} />
        )}
      </div>
    </div>
  )
}
