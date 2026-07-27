import { MessageSquarePlus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  DEFAULT_CLAUDE_CONFIG,
  DEFAULT_CODEX_CONFIG,
  type AgentConfig,
  type AgentKind,
} from '@sillage/protocol'
import { AGENT_LABELS, AgentIcon } from '../components/AgentIcon'
import { Composer } from '../components/chat/Composer'
import { EmptyState, Select, cx, type SelectOption } from '../components/ui'
import { WorktreeSelect } from '../components/WorktreeSelect'
import { useAllConversations, useCreateConversation } from '../lib/conversations'
import { useProjects } from '../lib/projects'
import { useSidebarHidden } from '../lib/sidebar'
import { uuidv4 } from '../lib/uuid'

const AGENT_OPTIONS: SelectOption<AgentKind>[] = [
  { value: 'claude', label: AGENT_LABELS.claude, icon: <AgentIcon agent="claude" size={15} /> },
  { value: 'codex', label: AGENT_LABELS.codex, icon: <AgentIcon agent="codex" size={15} /> },
]

/**
 * Conversation pas encore créée.
 *
 * Rien n'est écrit en base tant qu'aucun message n'a été envoyé : cliquer sur « + »
 * ne doit pas laisser un fil vide et sans titre dans la liste. La création et le
 * premier message partent ensemble, et c'est ce premier tour qui donne son titre à la
 * conversation.
 */
export function DraftConversationPage() {
  const { projectId } = useParams()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { data: conversations } = useAllConversations()
  const createConversation = useCreateConversation(projectId ?? '')
  const sidebarHidden = useSidebarHidden()

  // Valeur de départ seulement : le CLI reste modifiable tant que rien n'est envoyé.
  // Sans ça, le « + » de la sidebar enfermerait sur le CLI du dernier fil.
  const requested = params.get('agent')
  const suggested: AgentKind =
    requested === 'claude' || requested === 'codex'
      ? requested
      : (conversations?.find((c) => c.projectId === projectId)?.agent ?? 'claude')

  const [chosenAgent, setChosenAgent] = useState<AgentKind | null>(null)
  const agent = chosenAgent ?? suggested

  const [config, setConfig] = useState<AgentConfig | null>(null)
  const [worktreeId, setWorktreeId] = useState<string | null>(null)
  const { data: projects } = useProjects()
  const project = projects?.find((p) => p.id === projectId)

  const defaults = agent === 'claude' ? DEFAULT_CLAUDE_CONFIG : DEFAULT_CODEX_CONFIG
  // Une configuration Claude n'a aucun sens pour Codex : elle est abandonnée dès que
  // le CLI change, plutôt que conservée et rejetée par le serveur.
  const effective = useMemo(
    () => (config?.agent === agent ? config : defaults),
    [config, agent, defaults],
  )

  const send = async (text: string, attachmentIds: string[], mentions: string[]) => {
    if (!projectId) return

    const created = await createConversation.mutateAsync({
      agent,
      config: effective,
      worktreeId,
      firstMessage: { clientMessageId: uuidv4(), text, attachmentIds, mentions },
    })

    // `replace` : revenir en arrière ne doit pas ramener sur un brouillon qui n'a
    // plus lieu d'être.
    navigate(`/p/${projectId}/c/${created.id}`, { replace: true })
  }

  return (
    <div className="flex h-full flex-col pb-safe">
      <header
        className={cx(
          'flex shrink-0 items-center gap-2 border-b border-line px-2 py-2',
          // Place réservée au bouton de réaffichage de la navigation, qui se pose dans
          // ce coin quand la sidebar est repliée.
          sidebarHidden && 'md:pl-14',
        )}
      >
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">Nouvelle conversation</p>
          <div className="flex items-center gap-1.5 text-[0.6875rem] text-ink-faint">
            <AgentIcon agent={agent} size={11} />
            <span>{AGENT_LABELS[agent]}</span>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <EmptyState
          icon={<MessageSquarePlus size={22} />}
          title="Écris ton premier message"
          description="La conversation sera créée à l'envoi, et prendra le titre que le CLI lui donne."
        />

        {projectId ? (
          <div className="mx-auto flex max-w-sm flex-col gap-4 px-4 pb-6">
            <Select
              label="CLI"
              value={agent}
              onChange={setChosenAgent}
              options={AGENT_OPTIONS}
            />
            <WorktreeSelect
              projectId={projectId}
              value={worktreeId}
              onChange={setWorktreeId}
              isRepository={project?.git !== null && project !== undefined}
            />
          </div>
        ) : null}
      </div>

      <Composer
        config={effective}
        status="idle"
        disabled={createConversation.isPending}
        onSend={send}
        onInterrupt={() => {}}
        onConfigChange={setConfig}
        projectId={projectId}
        worktreeId={worktreeId}
      />
    </div>
  )
}
