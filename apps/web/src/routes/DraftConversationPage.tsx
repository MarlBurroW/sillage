import { Check } from 'lucide-react'
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
import { cx } from '../components/ui'
import { WorktreeSelect } from '../components/WorktreeSelect'
import { useAllConversations, useCreateConversation } from '../lib/conversations'
import { useProjects } from '../lib/projects'
import { useSidebarHidden } from '../lib/sidebar'
import { uuidv4 } from '../lib/uuid'

/**
 * Ce que chaque CLI apporte, en une phrase.
 *
 * Descriptif et non promotionnel : le choix se fait sur ce qui distingue réellement les
 * deux, pas sur des adjectifs. Les deux sont pilotés par le même journal et la même
 * interface, la différence est ailleurs.
 */
const AGENTS: { value: AgentKind; vendor: string; blurb: string }[] = [
  {
    value: 'claude',
    vendor: 'Anthropic',
    blurb: 'Sous-agents, mode plan, permissions demandées outil par outil.',
  },
  {
    value: 'codex',
    vendor: 'OpenAI',
    blurb: 'Mode plan, exécution en bac à sable, approbations groupées.',
  },
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
        <div className="mx-auto flex max-w-md flex-col gap-6 px-4 py-8">
          <div className="flex flex-col gap-1 text-center">
            <h1 className="text-xl font-semibold tracking-tight">Nouvelle conversation</h1>
            <p className="text-sm text-ink-faint">
              Elle sera créée à l&apos;envoi du premier message, et prendra le titre que le
              CLI lui donne.
            </p>
          </div>

          {/* Deux cartes plutôt qu'une liste déroulante : le CLI est le choix qui engage
              le plus, il n'y en a que deux, et chacun mérite sa phrase. */}
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-xs font-medium text-ink-soft">CLI</legend>
            <div role="radiogroup" aria-label="CLI" className="grid gap-2 sm:grid-cols-2">
              {AGENTS.map((option) => {
                const selected = option.value === agent
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setChosenAgent(option.value)}
                    className={cx(
                      'flex flex-col gap-2 rounded-lg border p-3 text-left transition-colors',
                      selected
                        ? 'border-accent bg-accent-wash'
                        : 'border-line hover:border-line-strong hover:bg-surface-high',
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <AgentIcon agent={option.value} size={18} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-ink">
                          {AGENT_LABELS[option.value]}
                        </span>
                        <span className="block truncate text-[0.6875rem] text-ink-faint">
                          {option.vendor}
                        </span>
                      </span>
                      {/* Place réservée : la coche apparaissant au choix décalerait le
                          libellé au moment du clic. */}
                      <span className="w-4 shrink-0 text-accent">
                        {selected ? <Check size={16} /> : null}
                      </span>
                    </span>
                    <span className="text-xs leading-snug text-ink-faint">{option.blurb}</span>
                  </button>
                )
              })}
            </div>
          </fieldset>

          {projectId ? (
            <WorktreeSelect
              projectId={projectId}
              value={worktreeId}
              onChange={setWorktreeId}
              isRepository={project?.git !== null && project !== undefined}
              layout="list"
            />
          ) : null}
        </div>
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
