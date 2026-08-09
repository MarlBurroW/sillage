import { Check, History, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  AGENT_CAPABILITIES,
  agentKindSchema,
  cardBranchName,
  defaultConfigFor,
  type AgentConfig,
  type AgentKind,
} from '@sillage/protocol'
import type { AgentSkillDto, McpServerStatus, SlashCommandDto } from '@sillage/protocol'
import { AGENT_LABELS, AGENT_META, AgentIcon } from '../components/AgentIcon'
import { Composer } from '../components/chat/Composer'
import { Banner, Button, IconButton, cx } from '../components/ui'
import { WorktreeSelect } from '../components/WorktreeSelect'
import { useCards } from '../lib/cards'
import {
  useAgentAvailability,
  useInstallAgent,
  unavailableReason,
  versionMismatch,
} from '../lib/agents'
import { useClaudeSessions, useImportClaudeSession } from '../lib/claude-sessions'
import { useAllConversations, useCreateConversation } from '../lib/conversations'
import { useProjects } from '../lib/projects'
import { locale, useTranslate } from '../lib/i18n'
import { useSidebarHidden } from '../lib/sidebar'
import { useUserSettings } from '../lib/user-settings'
import { uuidv4 } from '../lib/uuid'

/** Les cartes de choix suivent l'enum du protocole : un CLI ajouté apparaît seul. */
const AGENTS = agentKindSchema.options.map((value) => ({ value, ...AGENT_META[value] }))

/** Jour et heure courts : assez pour situer une session, sans manger la ligne. */
function formatDay(ts: number): string {
  return new Date(ts).toLocaleString(locale(), {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * Conversation pas encore créée.
 *
 * Rien n'est écrit en base tant qu'aucun message n'a été envoyé : cliquer sur « + »
 * ne doit pas laisser un fil vide et sans titre dans la liste. La création et le
 * premier message partent ensemble, et c'est ce premier tour qui donne son titre à la
 * conversation.
 */
const NO_MCP_INVENTORY: McpServerStatus[] = []
const NO_COMMANDS: SlashCommandDto[] = []
const NO_SKILLS: AgentSkillDto[] = []

export function DraftConversationPage() {
  const { projectId } = useParams()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const { data: conversations } = useAllConversations()
  const createConversation = useCreateConversation(projectId ?? '')
  const sidebarHidden = useSidebarHidden()

  // Valeur de départ seulement : le CLI reste modifiable tant que rien n'est envoyé.
  // Sans ça, le « + » de la sidebar enfermerait sur le CLI du dernier fil.
  const requested = agentKindSchema.safeParse(params.get('agent'))
  const suggested: AgentKind = requested.success
    ? requested.data
    : (conversations?.find((c) => c.projectId === projectId)?.agent ?? 'claude')

  const [chosenAgent, setChosenAgent] = useState<AgentKind | null>(null)
  const { data: availability } = useAgentAvailability()
  const install = useInstallAgent()
  const t = useTranslate()

  // La suggestion se replie sur un CLI installé. Sans ça le formulaire s'ouvrirait sur
  // une carte grisée, et l'envoi resterait possible puisque le grisage ne bloque que le
  // clic : le CLI par défaut est « claude » ou celui du dernier fil du projet, deux
  // valeurs qui ne savent rien de ce qui est réellement installé.
  //
  // Un choix explicite n'est jamais réécrit, lui : ni le clic de l'utilisateur, ni le
  // `?agent=` de l'URL. Basculer sous les doigts de quelqu'un qui vient de désigner un
  // CLI serait pire que de le laisser voir qu'il manque.
  const installed = (kind: AgentKind) =>
    availability?.agents.find((a) => a.agent === kind)?.installed !== false
  const fallback = availability?.agents.find((a) => a.installed)?.agent
  const agent =
    chosenAgent ?? (requested.success || installed(suggested) ? suggested : (fallback ?? suggested))

  const blocked = unavailableReason(availability?.agents.find((a) => a.agent === agent))

  const [config, setConfig] = useState<AgentConfig | null>(null)
  const { data: projects } = useProjects()
  const project = projects?.find((p) => p.id === projectId)

  // Le board ouvre ce brouillon avec sa carte. Rien n'est rattaché tant que rien n'est
  // envoyé : c'est une valeur de départ, comme le CLI, et la puce se retire.
  const [detached, setDetached] = useState(false)
  const { data: cards } = useCards(projectId)
  const requestedCard = params.get('card')
  const card = detached ? undefined : cards?.find((entry) => entry.id === requestedCard)
  /**
   * Le composer lit son texte initial une seule fois, au montage. Le rendre avant que
   * la carte soit connue le figerait sans sa mention, et la poser après n'y changerait
   * plus rien : on attend donc la réponse plutôt que de remonter le composant, ce qui
   * effacerait ce qui aurait été tapé entre-temps.
   */
  const cardPending = Boolean(requestedCard) && !detached && cards === undefined

  // Le worktree déjà rattaché à la carte, s'il y en a un : reprendre un chantier doit
  // retomber dans le bon arbre sans y penser. Le plus récent l'emporte, une carte ayant
  // pu changer de branche en route.
  const cardWorktree = card?.conversations.findLast((session) => session.worktreeId)?.worktreeId
  const [worktreeId, setWorktreeId] = useState<string | null>(null)
  const [worktreeTouched, setWorktreeTouched] = useState(false)
  const effectiveWorktreeId = worktreeTouched ? worktreeId : (cardWorktree ?? worktreeId)

  // Les défauts du compte tant qu'ils ne sont pas chargés : ceux du protocole ne sont
  // qu'un point de départ le temps d'un aller-retour, et rien n'est envoyé avant le
  // premier message.
  const { data: userSettings } = useUserSettings()
  const defaults = userSettings?.agentDefaults[agent] ?? defaultConfigFor(agent)
  // Une configuration Claude n'a aucun sens pour Codex : elle est abandonnée dès que
  // le CLI change, plutôt que conservée et rejetée par le serveur.
  const effective = useMemo(
    () => (config?.agent === agent ? config : defaults),
    [config, agent, defaults],
  )

  // Chargées seulement quand le CLI retenu persiste des sessions locales relisibles.
  // Un worktree écarte la liste : ces sessions vivent dans le dossier racine du projet.
  const { data: cliSessions } = useClaudeSessions(
    projectId,
    AGENT_CAPABILITIES[agent].cliSessions && !effectiveWorktreeId,
  )
  const cliSessionList = effectiveWorktreeId ? [] : (cliSessions?.sessions ?? [])
  const importSession = useImportClaudeSession(projectId ?? '')

  const importAndOpen = async (sessionId: string) => {
    const created = await importSession.mutateAsync(sessionId)
    navigate(`/p/${projectId}/c/${created.id}`, { replace: true })
  }

  const send = async (
    text: string,
    attachmentIds: string[],
    mentions: string[],
    skills: string[],
  ) => {
    if (!projectId) return

    const created = await createConversation.mutateAsync({
      agent,
      config: effective,
      worktreeId: effectiveWorktreeId,
      cardId: card?.id ?? null,
      // Le titre de la carte plutôt que l'extrait du message : la conversation traite
      // un travail nommé, et le CLI n'a plus à en proposer un.
      title: card?.title,
      firstMessage: { clientMessageId: uuidv4(), text, attachmentIds, mentions, skills },
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
          <p className="truncate text-sm font-medium">{t('draft.title')}</p>
          <div className="flex items-center gap-1.5 text-[0.6875rem] text-ink-faint">
            <AgentIcon agent={agent} size={11} />
            <span>{AGENT_LABELS[agent]}</span>
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-md flex-col gap-6 px-4 py-8">
          <div className="flex flex-col gap-1 text-center">
            <h1 className="text-xl font-semibold tracking-tight">{t('draft.title')}</h1>
            <p className="text-sm text-ink-faint">{t('draft.subtitle')}</p>
          </div>

          {/* Deux cartes plutôt qu'une liste déroulante : le CLI est le choix qui engage
              le plus, il n'y en a que deux, et chacun mérite sa phrase. */}
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1.5 text-xs font-medium text-ink-soft">{t('draft.cli.legend')}</legend>
            <div role="radiogroup" aria-label="CLI" className="grid gap-2 sm:grid-cols-2">
              {AGENTS.map((option) => {
                const selected = option.value === agent
                const entry = availability?.agents.find((a) => a.agent === option.value)
                // Indisponible seulement quand le serveur l'a dit. Tant que la sonde n'a
                // pas répondu, la carte reste active : griser par défaut ferait clignoter
                // le formulaire à chaque ouverture, et bloquerait un choix valide si la
                // route échouait.
                const unavailable = unavailableReason(entry)
                const mismatch = versionMismatch(entry)
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    disabled={unavailable !== null}
                    onClick={() => setChosenAgent(option.value)}
                    className={cx(
                      'flex flex-col gap-2 rounded-lg border p-3 text-left transition-colors',
                      unavailable
                        ? 'cursor-not-allowed border-line bg-surface-high opacity-60'
                        : selected
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
                    {/* La raison remplace l'accroche : sur une carte qu'on ne peut pas
                        choisir, vanter le CLI passe après le fait de dire pourquoi. */}
                    <span className="text-xs leading-snug text-ink-faint">
                      {unavailable ?? option.blurb}
                    </span>
                    {/* L'écart de version n'empêche rien : il s'ajoute, il ne remplace
                        pas, et ne grise pas la carte. */}
                    {mismatch ? (
                      <span className="text-xs leading-snug text-caution">{mismatch}</span>
                    ) : null}
                  </button>
                )
              })}
            </div>
            {/* Le cas où aucun CLI n'est installé, et celui d'un `?agent=` qui en désigne
                un absent : les cartes seules laisseraient l'écran sans explication de ce
                que la barre de saisie refuse. */}
            {blocked ? <Banner>{blocked}</Banner> : null}

            {/* Hors des cartes : chacune est déjà un bouton, et en imbriquer un second
                donnerait du HTML invalide. Un rang par CLI manquant, désactivé exclu :
                l'écarter est un choix de configuration, pas un manque à combler. */}
            {availability?.agents
              .filter((entry) => !entry.installed && entry.reason !== 'disabled')
              .map((entry) => (
                <div
                  key={entry.agent}
                  className="flex items-center justify-between gap-2 rounded-lg border border-line p-2"
                >
                  <span className="min-w-0 text-xs leading-snug text-ink-faint">
                    {entry.install.status === 'running'
                      ? t('agent.install.running', {
                          label: AGENT_LABELS[entry.agent],
                          version: entry.install.version,
                        })
                      : entry.install.status === 'failed'
                        ? entry.install.error
                        : t('agent.install.missing', { label: AGENT_LABELS[entry.agent] })}
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={entry.install.status === 'running' || install.isPending}
                    onClick={() => install.mutate(entry.agent)}
                  >
                    {entry.install.status === 'failed'
                      ? t('agent.install.retry')
                      : t('agent.install.action', { version: entry.preferredVersion })}
                  </Button>
                </div>
              ))}
          </fieldset>

          {card ? (
            <div className="flex items-center gap-2 rounded-md border border-line bg-sunken px-3 py-2">
              <span className="text-xs font-medium text-ink-faint">#{card.number}</span>
              <span className="min-w-0 flex-1 truncate text-sm text-ink-soft">{card.title}</span>
              <IconButton label={t('draft.card.detach')} onClick={() => setDetached(true)}>
                <X size={14} />
              </IconButton>
            </div>
          ) : null}

          {projectId ? (
            <WorktreeSelect
              projectId={projectId}
              value={effectiveWorktreeId}
              onChange={(next) => {
                setWorktreeTouched(true)
                setWorktreeId(next)
              }}
              isRepository={project?.git !== null && project !== undefined}
              layout="list"
              suggestedName={card ? cardBranchName(card.number, card.title) : undefined}
            />
          ) : null}

          {/* Sessions commencées au CLI dans ce dossier : plutôt qu'une nouvelle
              conversation, on peut adopter l'une d'elles. Importer ne copie rien,
              c'est la même session, qui reste reprenable avec `claude --resume`. */}
          {AGENT_CAPABILITIES[agent].cliSessions && cliSessionList.length > 0 ? (
            <section className="flex flex-col gap-1.5">
              <h2 className="text-xs font-medium text-ink-soft">
                {t('draft.cliSessions.title', { label: AGENT_LABELS[agent] })}
              </h2>
              <p className="text-xs leading-snug text-ink-faint">
                {t('draft.cliSessions.description')}
              </p>
              <div className="flex max-h-72 flex-col gap-1.5 overflow-y-auto">
                {cliSessionList.map((session) => (
                  <button
                    key={session.sessionId}
                    type="button"
                    disabled={importSession.isPending}
                    onClick={() => void importAndOpen(session.sessionId)}
                    className="flex items-center gap-2.5 rounded-md border border-line px-3 py-2 text-left transition-colors hover:border-line-strong hover:bg-surface-high disabled:opacity-60"
                  >
                    <History size={15} className="shrink-0 text-ink-faint" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-ink">{session.title}</span>
                      {session.firstPrompt && session.firstPrompt !== session.title ? (
                        <span className="block truncate text-xs text-ink-faint">
                          {session.firstPrompt}
                        </span>
                      ) : null}
                    </span>
                    <span className="shrink-0 text-right text-[0.6875rem] leading-tight text-ink-faint">
                      <time dateTime={new Date(session.lastModified).toISOString()}>
                        {formatDay(session.lastModified)}
                      </time>
                      {session.gitBranch ? (
                        <span className="block max-w-32 truncate">{session.gitBranch}</span>
                      ) : null}
                    </span>
                  </button>
                ))}
              </div>
              {importSession.isError ? (
                <Banner>
                  {importSession.error instanceof Error
                    ? importSession.error.message
                    : t('draft.import.error')}
                </Banner>
              ) : null}
            </section>
          ) : null}
        </div>
      </div>

      {cardPending ? null : (
        <Composer
          // Le brouillon d'une conversation pas encore créée appartient à son projet :
          // c'est le seul fil qu'on puisse en désigner avant qu'il existe. Un brouillon
          // par carte, sinon celui de la création libre écraserait la mention posée ici.
          draftKey={card ? `new:${projectId ?? ''}:card:${card.id}` : `new:${projectId ?? ''}`}
          initialText={card ? `#${card.number} ` : ''}
          config={effective}
          // Rien n'est encore lancé : aucun CLI n'a d'inventaire ni de commandes à
          // rapporter. La liste en `/` s'ouvrira au premier tour.
          mcpInventory={NO_MCP_INVENTORY}
          commands={NO_COMMANDS}
          skills={NO_SKILLS}
          status="idle"
          // Un CLI absent ne se rattrape pas côté serveur : le tour échouerait après
          // création de la conversation, laissant un fil vide et un message perdu.
          disabled={createConversation.isPending || blocked !== null}
          onSend={send}
          onInterrupt={() => {}}
          onConfigChange={setConfig}
          projectId={projectId}
          worktreeId={effectiveWorktreeId}
        />
      )}
    </div>
  )
}
