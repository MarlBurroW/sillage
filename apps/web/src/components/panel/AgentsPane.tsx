import { ArrowLeft, Bot, Radio, SquareTerminal, Waves } from 'lucide-react'
import { useMemo, type ReactNode } from 'react'
import type { BackgroundWork } from '../../lib/background'
import { useTranslate, type MessageKey } from '../../lib/i18n'
import { clearSubAgent, showSubAgent } from '../../lib/panel'
import { subAgentLabel, type SubAgent } from '../../lib/subagents'
import { formatTokens } from '../../lib/tokens'
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
  background,
  selectedId,
}: {
  conversationId: string
  agents: SubAgent[]
  /** Travaux poursuivis hors du tour, sans fil à ouvrir : le CLI n'en transmet rien. */
  background: BackgroundWork[]
  selectedId: string | null
}) {
  const t = useTranslate()
  const selected = agents.find((agent) => agent.id === selectedId) ?? null

  if (selected) {
    return (
      <SubAgentThread conversationId={conversationId} agent={selected} onBack={clearSubAgent} />
    )
  }

  if (agents.length === 0 && background.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center p-4">
        <EmptyState
          title={t('subagent.pane.empty.title')}
          description={t('subagent.pane.empty.description')}
        />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
      <BackgroundList tasks={background} />
      {agents.map((agent) => (
        <div key={agent.id} className={cx(agent.parentId && 'pl-3')}>
          <SubAgentRow agent={agent} onSelect={() => showSubAgent(agent.id)} />
        </div>
      ))}
    </div>
  )
}

type BackgroundFamily = 'workflow' | 'shell' | 'subagent' | 'monitor'

/**
 * Les noms sous lesquels le CLI annonce chaque famille de travaux.
 *
 * Deux orthographes par famille parce que le CLI les mélange : le SDK documente des
 * libellés lisibles (`shell`, `subagent`), et la version 2.1 émet ses discriminants
 * bruts (`local_bash`, `local_agent`). Le préfixe `local_` est retiré avant la
 * recherche, ce qui rattrape les deux d'un coup.
 */
const KIND_ALIASES: Record<string, BackgroundFamily | undefined> = {
  workflow: 'workflow',
  bash: 'shell',
  shell: 'shell',
  agent: 'subagent',
  subagent: 'subagent',
  mcp_task: 'monitor',
  monitor: 'monitor',
}

const KIND_ICONS: Record<BackgroundFamily, ReactNode> = {
  workflow: <Waves size={13} />,
  shell: <SquareTerminal size={13} />,
  subagent: <Bot size={13} />,
  monitor: <Radio size={13} />,
}

const KIND_LABELS: Record<BackgroundFamily, MessageKey> = {
  workflow: 'panel.background.kind.workflow',
  shell: 'panel.background.kind.shell',
  subagent: 'panel.background.kind.subagent',
  monitor: 'panel.background.kind.monitor',
}

/**
 * Les travaux de fond, au-dessus des sous-agents et non mêlés à eux.
 *
 * Ils n'ont pas de fil à ouvrir : le CLI en donne l'activité du moment, jamais ce
 * qu'ils écrivent. Une ligne sans clic est donc honnête, là où une ligne cliquable
 * promettrait un détail qui n'existe pas.
 */
function BackgroundList({ tasks }: { tasks: BackgroundWork[] }) {
  const t = useTranslate()
  if (tasks.length === 0) return null

  return (
    <section className="mb-1 flex flex-col gap-1">
      <h2 className="px-1 text-[0.6875rem] font-medium uppercase tracking-wide text-ink-faint">
        {t('panel.background.title')}
      </h2>
      {tasks.map((task) => {
        // Un type inconnu s'affiche tel qu'il est venu plutôt que d'être rangé de
        // force dans une famille : le CLI en ajoute au fil des versions.
        const family = KIND_ALIASES[task.kind.replace(/^local_/, '')]
        return (
          <div
            key={task.id}
            className="flex items-center gap-2 rounded-md border border-line bg-surface-high px-2 py-1.5"
          >
            <span className="shrink-0 text-accent">
              {family ? KIND_ICONS[family] : <Waves size={13} />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs text-ink">{task.description}</span>
              <span className="block truncate text-[0.6875rem] text-ink-faint">
                {/* La famille dit quelle sorte de travail tourne, l'activité ce qu'il
                    fait à l'instant : les deux tiennent sur la ligne. */}
                {task.activity
                  ? `${family ? t(KIND_LABELS[family]) : task.kind} · ${task.activity}`
                  : family
                    ? t(KIND_LABELS[family])
                    : task.kind}
              </span>
            </span>

            {task.toolUses > 0 ? (
              <span className="shrink-0 text-[0.6875rem] tabular-nums text-ink-faint">
                {t(task.toolUses > 1 ? 'panel.background.tools.many' : 'panel.background.tools.one', {
                  count: task.toolUses,
                })}
              </span>
            ) : null}
          </div>
        )
      })}
    </section>
  )
}

function SubAgentThread({
  conversationId,
  agent,
  onBack,
}: {
  conversationId: string
  agent: SubAgent
  onBack: () => void
}) {
  const t = useTranslate()
  const rows = useMemo(() => buildRows(agent.items, agent.id), [agent.items, agent.id])

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-2 py-1.5">
        <button
          type="button"
          onClick={onBack}
          aria-label={t('subagent.pane.back')}
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

        {/* Les tokens d'un sous-agent n'apparaissent nulle part ailleurs : ils ne
            comptent pas dans l'usage du tour, que seul l'agent principal alimente. */}
        {agent.totalTokens > 0 ? (
          <span className="shrink-0 text-[0.6875rem] tabular-nums text-ink-faint">
            {t('subagent.tokens', { count: formatTokens(agent.totalTokens) })}
          </span>
        ) : null}
      </div>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {rows.length === 0 ? (
          <p className="text-xs text-ink-faint">
            {/* Le CLI transmet le travail du sous-agent au fil de l'eau : entre le
                lancement et son premier mot, il n'y a rien à montrer. */}
            {agent.status === 'running'
              ? t('subagent.pane.starting')
              : t('subagent.pane.silent')}
          </p>
        ) : (
          <ChatThread rows={rows} conversationId={conversationId} />
        )}
      </div>
    </div>
  )
}
