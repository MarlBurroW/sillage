import {
  ArrowDown,
  ChevronDown,
  FolderTree,
  GaugeCircle,
  GitBranch,
  MoreHorizontal,
  PanelRight,
  Search,
  Shrink,
  WifiOff,
} from 'lucide-react'
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import {
  AGENT_CAPABILITIES,
  agentConfigSchema,
  type AgentConfig,
  type ConversationStatus,
} from '@sillage/protocol'
import { AGENT_LABELS, AgentIcon } from '../components/AgentIcon'
import { ChatThread } from '../components/chat/ChatThread'
import { SubAgentBar } from '../components/chat/SubAgentBar'
import { Composer } from '../components/chat/Composer'
import { ComposerStatus } from '../components/chat/ComposerStatus'
import { ConversationMinimap } from '../components/chat/ConversationMinimap'
import { QueuedMessages } from '../components/chat/QueuedMessages'
import { ThreadSearch } from '../components/chat/ThreadSearch'
import { TurnActivity } from '../components/chat/TurnActivity'
import { TurnNav } from '../components/chat/TurnNav'
import { UsagePanel } from '../components/chat/UsagePanel'
import { UsageSummary } from '../components/chat/UsageSummary'
import { useAgentModels } from '../lib/agents'
import { syncClaudeConversation } from '../lib/claude-sessions'
import { Banner, ConfirmDialog, EmptyState, IconButton, Menu, MenuItem, cx } from '../components/ui'
import { api } from '../lib/api'
import {
  compactConversation,
  conversationsKey,
  forkConversation,
  interruptConversation,
  sendMessage,
  steerConversation,
  useAllConversations,
  useConversation,
} from '../lib/conversations'
import { FileLinkContext } from '../lib/file-links'
import { clearSubAgent, setPanelOpen, usePanelPresence } from '../lib/panel'
import { useCurrentUser } from '../lib/session'
import { useSidebarHidden } from '../lib/sidebar'
import { describeActivity, type MessageItem } from '../lib/chat-fold'
import { buildSubAgents } from '../lib/subagents'
import { buildRows } from '../lib/tool-rows'
import { buildTurns } from '../lib/turns'
import { useChatStream } from '../lib/use-chat-stream'
import { useWorktrees } from '../lib/worktrees'

/**
 * Chargé à la demande : l'éditeur embarque CodeMirror, et le mettre dans le paquet
 * initial ferait payer à chaque ouverture de conversation un panneau qu'on n'ouvre pas
 * toujours.
 */
const SidePanel = lazy(() =>
  import('../components/panel/SidePanel').then((m) => ({ default: m.SidePanel })),
)

/** Marge sous laquelle on considère que l'utilisateur suit le bas du fil. */
const STICKY_THRESHOLD_PX = 120

/** Doit couvrir l'animation `sg-flash-turn`, sinon l'anneau est coupé net. */
const FLASH_DURATION_MS = 1500

export function ConversationPage() {
  const { conversationId } = useParams()
  const navigate = useNavigate()
  // Brouillon transmis par un fork : le message coupé revient dans la barre de saisie.
  const draft = (useLocation().state as { draft?: string } | null)?.draft ?? ''
  const queryClient = useQueryClient()
  const { data: user } = useCurrentUser()
  const { data: conversation } = useConversation(conversationId)
  const stream = useChatStream(conversationId, conversation?.status ?? 'idle')
  // Le catalogue porte la nature du compte : elle décide si un montant a un sens.
  // Comme tous les hooks, il doit rester avant le premier retour anticipé. La sonde
  // démarre le CLI côté serveur : elle ne part que pour l'agent de la conversation.
  const { data: catalog } = useAgentModels(conversation?.agent ?? 'claude', Boolean(conversation))
  const { data: worktrees } = useWorktrees(conversation?.projectId)
  // Déjà chargée pour la sidebar : la provenance d'une branche s'y trouve sans requête
  // supplémentaire.
  const { data: allConversations } = useAllConversations()

  const scroller = useRef<HTMLDivElement>(null)
  const [stuckToBottom, setStuckToBottom] = useState(true)

  /** Position de chaque tour dans le fil, alimentée par les messages utilisateur. */
  const turnAnchors = useRef(new Map<string, HTMLElement>())
  const [visibleTurns, setVisibleTurns] = useState<Set<string>>(() => new Set())
  const visibilityFrame = useRef<number | null>(null)

  const turns = useMemo(() => buildTurns(stream.state.items), [stream.state.items])
  const rows = useMemo(() => buildRows(stream.state.items), [stream.state.items])
  const subAgents = useMemo(() => buildSubAgents(stream.state.items), [stream.state.items])
  const runningSubAgents = useMemo(
    () => subAgents.filter((agent) => agent.status === 'running'),
    [subAgents],
  )
  const [usageOpen, setUsageOpen] = useState(false)
  const [forking, setForking] = useState(false)
  /** Message dont le fork est proposé : le geste est trop peu courant pour être direct. */
  const [forkTarget, setForkTarget] = useState<MessageItem | null>(null)
  /** Échec d'une action ponctuelle sur la conversation : fork, compaction. */
  const [actionError, setActionError] = useState<string | null>(null)
  const [compacting, setCompacting] = useState(false)
  /** Dernier tour atteint par un saut, mis en évidence le temps qu'on le repère. */
  const [flashed, setFlashed] = useState<string | null>(null)
  const [metaOpen, setMetaOpen] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  /** Message visé par un résultat de recherche, une fois le fil chargé. */
  const [searchParams] = useSearchParams()
  const anchorSeq = Number(searchParams.get('seq'))
  const anchored = useRef<number | null>(null)
  const activity = describeActivity(stream.state)
  const sidebarHidden = useSidebarHidden()
  const panel = usePanelPresence()

  /**
   * Tours dont la région croise la zone affichée. La région d'un tour va de son
   * message utilisateur au suivant : c'est ce qui permet à un long tour de rester
   * mis en évidence tant qu'on est encore dedans.
   */
  const syncVisibleTurns = useCallback(() => {
    const node = scroller.current
    if (!node) return

    const top = node.scrollTop
    const bottom = top + node.clientHeight

    const anchors = [...turnAnchors.current.entries()]
      .map(([id, element]) => ({ id, top: element.offsetTop }))
      .sort((a, b) => a.top - b.top)

    const next = new Set<string>()
    anchors.forEach((anchor, index) => {
      const end = anchors[index + 1]?.top ?? node.scrollHeight
      if (end > top && anchor.top < bottom) next.add(anchor.id)
    })

    // Un nouvel ensemble à chaque événement de défilement redessinerait la réglette
    // en continu : on ne remplace l'état que s'il a réellement changé.
    setVisibleTurns((current) =>
      current.size === next.size && [...next].every((id) => current.has(id)) ? current : next,
    )
  }, [])

  const onScroll = useCallback(() => {
    const node = scroller.current
    if (!node) return
    const distance = node.scrollHeight - node.scrollTop - node.clientHeight
    setStuckToBottom(distance < STICKY_THRESHOLD_PX)

    if (visibilityFrame.current !== null) return
    visibilityFrame.current = requestAnimationFrame(() => {
      visibilityFrame.current = null
      syncVisibleTurns()
    })
  }, [syncVisibleTurns])

  const jumpToTurn = useCallback((id: string) => {
    const anchor = turnAnchors.current.get(id)
    const node = scroller.current
    if (!anchor || !node) return
    // `scrollTo` plutôt que `scrollIntoView` : ce dernier fait aussi défiler les
    // conteneurs parents, donc la page entière sur mobile.
    node.scrollTo({ top: anchor.offsetTop - 12, behavior: 'smooth' })
    // Sur un fil dense, arriver quelque part sans savoir où l'on a atterri ne vaut
    // guère mieux que de ne pas s'être déplacé : le message atteint se signale.
    setFlashed(id)
  }, [])

  /**
   * La recherche dans le fil prend le raccourci de recherche du navigateur.
   *
   * C'est le geste attendu dans une application, et la recherche native ne sait ni
   * compter les occurrences ni sauter de l'une à l'autre dans un conteneur qui défile
   * seul. Elle reste atteignable par le menu du navigateur.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'f') return

      // Depuis le panneau, c'est l'éditeur qui doit chercher dans son fichier :
      // sans ce partage, le raccourci ouvrait les deux recherches à la fois.
      const target = event.target
      if (target instanceof Element && target.closest('[aria-label="Panneau du workspace"]')) return

      event.preventDefault()
      setFindOpen(true)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  /**
   * Rattrape les tours faits au CLI Claude Code hors de Sillage.
   *
   * Le CLI relit toujours le transcript complet, mais le journal est sa propre copie :
   * sans ce rattrapage à l'ouverture, une session poursuivie au terminal s'afficherait
   * ici tronquée. Les événements repris arrivent par l'abonnement WebSocket, comme le
   * direct, donc il n'y a rien à recharger.
   */
  useEffect(() => {
    if (!conversationId || !conversation?.isOwner) return
    if (!AGENT_CAPABILITIES[conversation.agent].cliSessions) return
    syncClaudeConversation(conversationId).catch((err: unknown) => {
      // Un rattrapage manqué n'empêche pas la conversation de vivre, mais le taire
      // rendrait indiagnosticable un fil qui semble incomplet.
      console.error('Resynchronisation du transcript CLI impossible :', err)
    })
  }, [conversationId, conversation?.agent, conversation?.isOwner])

  // Un appel de spawn n'existe que dans son fil : gardée d'une conversation à l'autre,
  // la sélection ouvrirait le panneau sur un sous-agent introuvable.
  useEffect(() => clearSubAgent, [conversationId])

  // L'anneau s'efface tout seul. Sans ça, il resterait sur un message qu'on a quitté
  // depuis longtemps et cesserait de vouloir dire « c'est là que tu viens d'arriver ».
  useEffect(() => {
    if (!flashed) return
    const timer = setTimeout(() => setFlashed(null), FLASH_DURATION_MS)
    return () => clearTimeout(timer)
  }, [flashed])

  /**
   * Ouverture sur un message précis, quand on arrive depuis la recherche.
   *
   * Le journal est chargé en entier, donc le message est déjà dans le fil : il ne
   * reste qu'à l'y trouver. Une seule fois par cible, sinon chaque événement reçu
   * ramènerait le défilement au même endroit pour le reste de la session.
   */
  useEffect(() => {
    const node = scroller.current
    if (stream.loading || !node || !Number.isInteger(anchorSeq) || anchorSeq <= 0) return
    if (anchored.current === anchorSeq) return

    const target = stream.state.items.find(
      (item) => item.kind === 'message' && item.seq === anchorSeq,
    )
    const element = node.querySelector<HTMLElement>(`[data-seq="${anchorSeq}"]`)
    if (!target || !element) return

    anchored.current = anchorSeq
    node.scrollTo({ top: element.offsetTop - 12 })
    setFlashed(target.id)
  }, [anchorSeq, stream.loading, stream.state.items])

  /**
   * Tour suivant ou précédent, à partir de la position de défilement.
   *
   * Volontairement pas à partir de `visibleTurns` : après un saut, le tour
   * précédent reste visible, puisque sa région s'étend jusqu'au message suivant.
   * Prendre le premier visible ramenait donc systématiquement au même endroit, et
   * la flèche « suivant » ne descendait jamais.
   *
   * Les ancres sont relues à chaque appel : elles bougent à mesure que le contenu
   * grandit, et une position mémorisée serait périmée dès le tour suivant.
   */
  const step = useCallback((direction: -1 | 1) => {
    const node = scroller.current
    if (!node) return

    const anchors = [...turnAnchors.current.entries()]
      .map(([id, element]) => ({ id, top: element.offsetTop }))
      .sort((a, b) => a.top - b.top)

    // Tolérance : le saut se pose à `offsetTop - 12`, et un défilement fluide
    // s'arrête à quelques pixels près. Sans elle, le tour où l'on vient d'arriver
    // se retrouve « en dessous » de lui-même et la flèche fait du surplace.
    const cursor = node.scrollTop + 16
    const target =
      direction === 1
        ? anchors.find((anchor) => anchor.top > cursor)
        : [...anchors].reverse().find((anchor) => anchor.top < cursor - 8)

    if (target) jumpToTurn(target.id)
  }, [jumpToTurn])

  // Défilement avant peinture : sinon le fil saute visiblement à chaque delta.
  useLayoutEffect(() => {
    if (!stuckToBottom) return
    const node = scroller.current
    if (node) node.scrollTop = node.scrollHeight
  }, [stream.state.items, stream.state.lastSeq, stuckToBottom])

  // Le contenu qui grandit déplace les tours : la réglette doit suivre, y compris
  // quand on ne défile pas soi-même.
  useEffect(syncVisibleTurns, [syncVisibleTurns, stream.state.items, stream.state.lastSeq])

  // Le clavier qui s'ouvre réduit la zone du fil : sans ce recalage, le dernier
  // message se retrouve masqué juste au moment où on répond.
  useEffect(() => {
    const viewport = window.visualViewport
    if (!viewport) return

    const stick = () => {
      const node = scroller.current
      if (stuckToBottom && node) node.scrollTop = node.scrollHeight
    }
    viewport.addEventListener('resize', stick)
    return () => viewport.removeEventListener('resize', stick)
  }, [stuckToBottom])

  // Le titre vit dans la ligne de conversation, pas dans le journal : il est relu
  // quand un tour se termine, moment où le CLI a pu en proposer un.
  useEffect(() => {
    if (!stream.state.turnRunning && conversationId) {
      void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] })
    }
  }, [stream.state.turnRunning, conversationId, queryClient])

  /**
   * Branche la conversation juste avant un message.
   *
   * La coupe se fait à `seq - 1` : la branche reprend tout ce qui précède, et le
   * message coupé revient dans la barre de saisie pour être reformulé. C'est le geste
   * que le fork sert à faire, et le laisser dans l'historique le rendrait inutile.
   *
   * Stable d'un rendu à l'autre : passée telle quelle aux bulles utilisateur, une
   * fonction recréée à chaque rendu casse leur mémoïsation, et le fil entier est
   * redessiné à chaque défilement. Le surlignage de la recherche, qui tient des plages
   * sur ces nœuds de texte, les perdait au passage.
   */
  const fork = useCallback(
    async (message: MessageItem) => {
      if (!conversationId) return

      setForkTarget(null)
      setForking(true)
      setActionError(null)
      try {
        const branch = await forkConversation(conversationId, message.seq - 1)
        void queryClient.invalidateQueries({ queryKey: ['conversations'] })
        const draft = message.blocks
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n\n')
        navigate(`/p/${branch.projectId}/c/${branch.id}`, { state: { draft } })
      } catch (err) {
        setActionError(err instanceof Error ? err.message : 'Fork impossible.')
      } finally {
        setForking(false)
      }
    },
    [conversationId, navigate, queryClient],
  )

  if (!conversationId || !conversation) return null

  const isOwner = conversation.userId === user?.id
  // Relu par le schéma plutôt que casté : une configuration enregistrée avant un
  // nouveau champ récupère ainsi ses valeurs par défaut au lieu d'arriver trouée.
  const config = agentConfigSchema.parse(conversation.config)
  const worktree = worktrees?.find((entry) => entry.id === conversation.worktreeId)
  const origin = conversation.forkedFromId
    ? allConversations?.find((entry) => entry.id === conversation.forkedFromId)
    : undefined

  const updateConfig = async (next: AgentConfig) => {
    await api.patch(`/api/conversations/${conversationId}`, { config: next })
    void queryClient.invalidateQueries({ queryKey: ['conversation', conversationId] })
  }


  const compact = async () => {
    setCompacting(true)
    setActionError(null)
    try {
      await compactConversation(conversationId)
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Compaction impossible.')
    } finally {
      setCompacting(false)
    }
  }

  const send = async (text: string, attachmentIds: string[], mentions: string[]) => {
    await sendMessage(conversationId, text, attachmentIds, mentions)
    void queryClient.invalidateQueries({ queryKey: conversationsKey(conversation.projectId) })
  }

  const steer = (text: string, attachmentIds: string[], mentions: string[]) =>
    steerConversation(conversationId, text, attachmentIds, mentions).then(() => undefined)

  // `relative` porte le bouton de retour en bas, et la hauteur retire l'en-tête
  // mobile de la coque, absent en desktop.
  return (
    // Le workspace de cette conversation sert de référence aux chemins cités dans le
    // fil : c'est lui, et pas le projet, qui décide de ce qu'un chemin relatif désigne
    // quand la conversation tourne dans un worktree.
    <FileLinkContext.Provider value={conversationId}>
    {/* Deux colonnes : le fil, et le panneau latéral quand il est ouvert. `relative`
        sert d'ancrage au panneau, qui se met en surimpression au doigt. */}
    <div className="relative flex h-full">
      <div
        className={cx(
          // `@container` : la réglette et les réglages du composer se replient selon la
          // largeur réellement disponible pour le fil, pas celle de la fenêtre, qui
          // ignore la sidebar comme le panneau. Ouvrir le panneau replie donc les
          // réglages tout seul, sans une ligne de plus.
          // `h-full` : la hauteur vient du calque racine, qui suit déjà le viewport
          // visuel. Un calcul local reproduirait ce que la coque sait déjà.
          '@container relative flex h-full min-w-0 flex-1 flex-col pb-safe',
        )}
      >
        <header
          className={cx(
            'surface sticky top-0 z-10 flex shrink-0 items-center gap-3',
            'border-b border-line px-2 py-2 md:px-4 md:py-2.5',
            // Le bouton de réaffichage de la navigation se pose dans ce coin : sans place
            // réservée, il recouvre l'icône du CLI.
            sidebarHidden && 'md:pl-14',
          )}
        >
          <span
            aria-hidden
            className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-surface-high"
          >
            <AgentIcon agent={conversation.agent} size={17} />
          </span>

          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium">{conversation.title}</p>

            {/* Métadonnées en pastilles plutôt qu'en texte courant : elles restent
                lisibles une fois tronquées sur un écran étroit.

                Repliées par défaut au doigt : quatre pastilles écrasées dans 390 px ne
                se lisent plus, alors que ce sont des repères qu'on consulte de temps en
                temps et non en permanence. Sur grand écran, la place existe. */}
            <div
              className={cx(
                'mt-0.5 items-center gap-1.5 overflow-x-auto text-[0.6875rem] text-ink-faint',
                metaOpen ? 'flex' : 'hidden md:flex',
              )}
            >
              <Meta title={AGENT_LABELS[conversation.agent]}>
                {stream.state.model ?? AGENT_LABELS[conversation.agent]}
              </Meta>

              <Meta
                icon={worktree ? <GitBranch size={10} /> : <FolderTree size={10} />}
                title={worktree ? `Worktree ${worktree.name}` : 'Dossier du projet'}
              >
                {worktree ? worktree.name : 'projet'}
              </Meta>

              {/* Une branche dit d'où elle vient : sans ça, deux fils presque identiques
                  dans la sidebar sont impossibles à distinguer. Le lien disparaît si
                  l'originale a été supprimée, la référence devenant orpheline. */}
              {origin ? (
                <Link
                  to={`/p/${origin.projectId}/c/${origin.id}`}
                  className="flex shrink-0 items-center gap-1 rounded-full bg-surface-high px-1.5 py-0.5 hover:text-ink"
                  title={`Branche de « ${origin.title} »`}
                >
                  <GitBranch size={10} />
                  <span className="max-w-32 truncate">{origin.title}</span>
                </Link>
              ) : null}

              {/* Tout vient du fold : le journal est la seule source d'affichage (I2),
                  et lui seul porte le détail des tokens de cache. */}
              <UsageSummary
                account={catalog?.account}
                rateLimit={stream.state.rateLimit}
                costUsd={stream.state.costUsd}
                inputTokens={stream.state.inputTokens}
                outputTokens={stream.state.outputTokens}
                cacheCreationTokens={stream.state.cacheCreationTokens}
                cacheReadTokens={stream.state.cacheReadTokens}
              />
            </div>
          </div>

          <button
            type="button"
            onClick={() => setMetaOpen((value) => !value)}
            aria-expanded={metaOpen}
            aria-label={metaOpen ? 'Masquer les détails' : 'Afficher les détails'}
            className="flex size-9 shrink-0 items-center justify-center rounded-md text-ink-faint md:hidden"
          >
            <ChevronDown size={16} className={cx('transition-transform', metaOpen && 'rotate-180')} />
          </button>

          {!stream.connected ? (
            <span title="Hors ligne, reconnexion en cours" className="shrink-0 text-caution">
              <WifiOff size={15} />
            </span>
          ) : null}
          <StatusPill status={stream.status} />

          {/* La consommation appartient au compte, pas à la conversation : le panneau
              reste le même quel que soit le fil ouvert. */}
          <button
            type="button"
            onClick={() => setUsageOpen(true)}
            title="Consommation du compte"
            className={cx(
              'flex shrink-0 items-center gap-1.5 rounded-full border border-line',
              'bg-surface-high px-2 py-1 text-[0.6875rem] font-medium text-ink-soft',
              'transition-colors hover:border-line-strong hover:text-ink',
            )}
          >
            <GaugeCircle size={13} />
            {/* Réduit à son icône au doigt : la consommation doit rester joignable
                depuis un téléphone, c'est le libellé qui prend la place, pas le bouton. */}
            <span className="hidden md:inline">Utilisation</span>
          </button>

          {/* Sur grand écran les deux actions sont posées directement : elles sont peu
              nombreuses, et un menu qui n'en cache que deux coûte un clic pour rien.
              Au doigt la place manque, elles repassent derrière les trois points.

              Lire une conversation partagée donne le droit d'y chercher : seule la
              compaction touche à l'état du fil, et elle reste au propriétaire. */}
          <span className="hidden md:contents">
            <IconButton label="Rechercher dans la conversation" onClick={() => setFindOpen(true)}>
              <Search size={18} />
            </IconButton>
            {isOwner ? (
              <IconButton
                label={
                  compacting || stream.state.compacting
                    ? 'Compaction en cours...'
                    : 'Compacter le contexte'
                }
                // Le contexte bouge encore pendant un tour : compacter au milieu
                // résumerait un état que l'agent est en train de changer.
                disabled={compacting || stream.state.compacting || stream.status !== 'idle'}
                onClick={() => void compact()}
              >
                <Shrink size={18} />
              </IconButton>
            ) : null}
          </span>

          <span className="md:hidden">
            <Menu
              trigger={
                <IconButton label="Actions de la conversation">
                  <MoreHorizontal size={18} />
                </IconButton>
              }
            >
              <MenuItem icon={<Search size={14} />} onSelect={() => setFindOpen(true)}>
                Rechercher dans la conversation
              </MenuItem>
              {isOwner ? (
                <MenuItem
                  icon={<Shrink size={14} />}
                  disabled={compacting || stream.state.compacting || stream.status !== 'idle'}
                  onSelect={() => void compact()}
                >
                  {compacting || stream.state.compacting
                    ? 'Compaction en cours...'
                    : 'Compacter le contexte'}
                </MenuItem>
              ) : null}
            </Menu>
          </span>

          {/* Tout à droite, contre le bord : c'est le panneau qu'il ouvre, et il doit
              se trouver du côté où celui-ci apparaît. Le panneau appartient à la
              conversation, il lit le répertoire de travail de ce fil, worktree
              compris, pas celui du projet. */}
          <IconButton
            label={panel.open ? 'Fermer le panneau' : 'Ouvrir le panneau'}
            onClick={() => setPanelOpen(!panel.open)}
          >
            <PanelRight size={18} className={cx(panel.open && 'text-accent')} />
          </IconButton>
        </header>

        <UsagePanel agent={conversation.agent} open={usageOpen} onOpenChange={setUsageOpen} />

        <ConfirmDialog
          open={forkTarget !== null}
          onOpenChange={(next) => {
            if (!next) setForkTarget(null)
          }}
          title="Forker à partir de ce message ?"
          confirmLabel="Forker"
          busy={forking}
          onConfirm={() => {
            if (forkTarget) void fork(forkTarget)
          }}
        >
          <p>
            Une nouvelle conversation est créée avec tout l'historique <em>jusqu'au message
            précédent</em>. Ce message-ci n'en fait pas partie : il revient dans la barre de
            saisie de la branche, prêt à être reformulé.
          </p>
          <p>
            La conversation actuelle n'est pas touchée, et l'agent de la branche repart du
            contexte tel qu'il était à cet instant.
          </p>
        </ConfirmDialog>

        <ThreadSearch
          scroller={scroller}
          open={findOpen}
          onClose={() => setFindOpen(false)}
          revision={stream.state.lastSeq}
        />

        <div
          ref={scroller}
          onScroll={onScroll}
          className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain"
        >
          {/* Seule la réglette latérale a besoin d'une gouttière, et seulement là où elle
              s'affiche. Elle est symétrique, sinon le fil cesse d'être centré. Rien à
              réserver à droite : les flèches de navigation sont posées au-dessus de la
              barre de saisie, hors du fil. */}
          <div className="mx-auto flex max-w-3xl flex-col gap-3 p-3 md:p-6 @min-[40rem]:px-12">
            {stream.error ? <Banner>{stream.error}</Banner> : null}
            {actionError ? <Banner>{actionError}</Banner> : null}

            {!stream.loading && stream.state.items.length === 0 ? (
              <EmptyState
                title="Conversation vide"
                description="Écris un premier message pour lancer l'agent."
              />
            ) : null}

            <ChatThread
              rows={rows}
              conversationId={conversationId}
              canDecide={isOwner}
              onFork={isOwner && !forking ? setForkTarget : undefined}
              flashedId={flashed}
              anchors={turnAnchors}
            />

            {activity ? <TurnActivity label={activity} /> : null}

            {/* Sous l'indicateur : ce que l'agent n'a pas encore lu. */}
            <QueuedMessages
              conversationId={conversationId}
              messages={stream.state.queued}
              canCancel={isOwner}
            />
          </div>
        </div>

        <ConversationMinimap
          turns={turns}
          visibleIds={visibleTurns}
          agentLabel={AGENT_LABELS[conversation.agent]}
          onJump={jumpToTurn}
        />

        {/* Les commandes de défilement se posent juste au-dessus de la barre de saisie,
            dont la hauteur varie : `bottom-full` sur ce conteneur les y ancre sans
            dépendre d'un décalage fixe. Elles ne servent qu'une fois le fil quitté du
            bas, donc elles disparaissent quand on y est revenu. */}
        <div className="relative shrink-0">
          {!stuckToBottom ? (
            <>
              <button
                type="button"
                onClick={() => {
                  const node = scroller.current
                  if (node) node.scrollTop = node.scrollHeight
                  setStuckToBottom(true)
                }}
                className={cx(
                  'absolute bottom-full left-1/2 z-10 mb-2 -translate-x-1/2',
                  'surface rounded-full border border-line p-2 text-ink-soft shadow-float',
                )}
                aria-label="Revenir en bas"
              >
                <ArrowDown size={16} />
              </button>

              <div className="absolute right-3 bottom-full z-10 mb-2">
                <TurnNav count={turns.length} onStep={step} />
              </div>
            </>
          ) : null}

          {/* Entre le fil et la barre de saisie : c'est la dernière chose qu'on voit
              avant d'écrire, et elle reste en place quand on remonte lire le fil. */}
          <SubAgentBar agents={runningSubAgents} />

          <Composer
            key={conversationId}
            initialText={draft}
            draftKey={conversationId}
            config={config}
            status={stream.status}
            disabled={!isOwner}
            context={stream.state.context}
            // Seul Codex sait infléchir un tour (`turn/steer`). Côté Claude, un message
            // poussé en cours de tour s'y mêle au lieu de le réorienter, donc le bouton
            // n'existe pas plutôt que d'être proposé puis refusé.
            onSteer={isOwner && AGENT_CAPABILITIES[conversation.agent].steer ? steer : undefined}
            onSend={send}
            onInterrupt={() => void interruptConversation(conversationId)}
            onConfigChange={(next) => void updateConfig(next)}
            projectId={conversation.projectId}
            worktreeId={conversation.worktreeId}
            footer={
              <ComposerStatus
                agent={conversation.agent}
                connected={stream.connected}
                warm={stream.warm}
                queued={stream.state.queued.length}
              />
            }
          />
        </div>
      </div>

      {/* Monté le temps de la sortie : `panel.open` porte l'état visé, `panel.mounted`
          la présence dans le document. Pas de voile d'attente, le panneau apparaît
          quand son code est là plutôt que de faire clignoter une colonne vide. */}
      {panel.mounted ? (
        <Suspense fallback={null}>
          <SidePanel
            conversationId={conversationId}
            editTurns={stream.state.editTurns}
            turnRunning={stream.state.turnRunning}
            subAgents={subAgents}
            open={panel.open}
          />
        </Suspense>
      ) : null}
    </div>
    </FileLinkContext.Provider>
  )
}

function Meta({
  icon,
  title,
  children,
}: {
  icon?: React.ReactNode
  title: string
  children: React.ReactNode
}) {
  return (
    <span
      title={title}
      className="flex shrink-0 items-center gap-1 rounded-full bg-surface-high px-1.5 py-0.5"
    >
      {icon}
      <span className="max-w-40 truncate font-mono">{children}</span>
    </span>
  )
}

const STATUS_PILLS: Partial<
  Record<ConversationStatus, { label: string; dot: string; text: string }>
> = {
  running: { label: 'En cours', dot: 'bg-accent animate-pulse', text: 'text-accent' },
  awaiting_input: { label: 'En attente', dot: 'bg-caution', text: 'text-caution' },
  interrupted: { label: 'Interrompu', dot: 'bg-caution', text: 'text-caution' },
  error: { label: 'Erreur', dot: 'bg-critical', text: 'text-critical' },
}

/** Au repos, aucun indicateur : c'est l'état normal, l'afficher ne dit rien. */
function StatusPill({ status }: { status: ConversationStatus }) {
  const pill = STATUS_PILLS[status]
  if (!pill) return null

  return (
    <span
      className={cx(
        'flex shrink-0 items-center gap-1.5 rounded-full border border-line',
        'bg-surface-high px-2 py-1 text-[0.6875rem] font-medium',
        pill.text,
      )}
    >
      <span className={cx('size-1.5 rounded-full', pill.dot)} />
      <span className="hidden sm:inline">{pill.label}</span>
    </span>
  )
}
