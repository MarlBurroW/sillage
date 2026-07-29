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
} from 'lucide-react'
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import {
  AGENT_CAPABILITIES,
  agentConfigSchema,
  type AgentConfig,
} from '@sillage/protocol'
import { AGENT_LABELS, AgentIcon } from '../components/AgentIcon'
import { ChatThread } from '../components/chat/ChatThread'
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
import { useFileDrop } from '../lib/file-drop'
import { FileLinkContext } from '../lib/file-links'
import { useTranslate } from '../lib/i18n'
import { clearSubAgent, setPanelOpen, usePanelPresence } from '../lib/panel'
import { useCurrentUser } from '../lib/session'
import { useSidebarHidden } from '../lib/sidebar'
import { describeActivity, type MessageItem } from '../lib/chat-fold'
import { buildBackground, type BackgroundWork } from '../lib/background'
import { buildLoops, type ArmedLoop } from '../lib/loops'
import { buildSignals, type SignalKind } from '../lib/signals'
import { SignalRow } from '../components/chat/Signals'
import { buildSubAgents } from '../lib/subagents'
import { buildRows } from '../lib/tool-rows'
import { readThreadScroll, saveThreadScroll } from '../lib/thread-scroll'
import {
  INITIAL_WINDOW_ROWS,
  WINDOW_STEP_ROWS,
  windowRows,
  windowToReveal,
} from '../lib/thread-window'
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

/** Instance unique : une liste vide recréée à chaque rendu ferait rendre le panneau. */
const NO_BACKGROUND: BackgroundWork[] = []
const NO_LOOPS: ArmedLoop[] = []

/** Ce que l'en-tête garde : les états sous lesquels ce qu'on lit n'est plus à jour. */
const HEADER_SIGNALS = new Set<SignalKind>(['error', 'interrupted', 'offline'])

/** Assez lâche pour une ancienneté affichée à la minute, assez court pour ne pas mentir. */
const TICK_MS = 30_000

function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [active])

  return now
}

/** Marge sous laquelle on considère que l'utilisateur suit le bas du fil. */
const STICKY_THRESHOLD_PX = 120

/** Doit couvrir l'animation `sg-flash-turn`, sinon l'anneau est coupé net. */
const FLASH_DURATION_MS = 1500

/**
 * Ramène le fil tout en bas.
 *
 * La position visée est calculée plutôt que laissée au rognage d'un `scrollTop` trop
 * grand, et reposée à la frame suivante : la hauteur du fil bouge encore après le saut,
 * le temps que les blocs de code et les images se mettent en place, et viser une hauteur
 * périmée laisse le fil arrêté avant sa fin.
 */
function scrollToBottom(node: HTMLElement): void {
  node.scrollTop = node.scrollHeight - node.clientHeight
  requestAnimationFrame(() => {
    node.scrollTop = node.scrollHeight - node.clientHeight
  })
}

export function ConversationPage() {
  const t = useTranslate()
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
  /**
   * Le fil est en place et peut se montrer.
   *
   * Faux pendant tout le rejeu du journal : le fil s'y construit par paquets, à une
   * position qui ne veut encore rien dire, et le donner à voir dans cet état revient à
   * montrer l'échafaudage. Faux aussi le temps d'un changement de conversation, où le
   * fil précédent est encore monté.
   */
  const [placed, setPlaced] = useState(false)

  /** Position de chaque tour dans le fil, alimentée par les messages utilisateur. */
  const turnAnchors = useRef(new Map<string, HTMLElement>())
  const [visibleTurns, setVisibleTurns] = useState<Set<string>>(() => new Set())
  const visibilityFrame = useRef<number | null>(null)

  const turns = useMemo(() => buildTurns(stream.state.items), [stream.state.items])
  const rows = useMemo(() => buildRows(stream.state.items), [stream.state.items])
  const subAgents = useMemo(
    () => buildSubAgents(stream.state.items, stream.state.tasks),
    [stream.state.items, stream.state.tasks],
  )
  const runningSubAgents = useMemo(
    () => subAgents.filter((agent) => agent.status === 'running'),
    [subAgents],
  )
  /**
   * Le journal peut rester sur un travail de fond que plus rien ne fait tourner : un
   * démon tué net n'écrit pas la fin de session qui l'aurait éteint. Une session
   * froide n'a plus de process, donc plus de travail de fond, quoi qu'en dise le fil.
   */
  const background = useMemo(
    () => (stream.warm === false ? NO_BACKGROUND : buildBackground(stream.state)),
    [stream.warm, stream.state],
  )
  /** Même raison que le travail de fond : une tâche planifiée ne tire que si le CLI vit. */
  const loops = useMemo(
    () => (stream.warm === false ? NO_LOOPS : buildLoops(stream.state)),
    [stream.warm, stream.state],
  )
  /**
   * Réveillé périodiquement pour que l'ancienneté du dernier réveil d'une boucle ne
   * fige pas. Sans boucle armée, aucun signal ne dépend de l'heure et le minuteur ne
   * tourne pas.
   */
  const now = useTicker(loops.length > 0)
  const signals = useMemo(
    () =>
      buildSignals({
        status: stream.status,
        connected: stream.connected,
        subAgents: runningSubAgents,
        background,
        loops,
        queued: stream.state.queued,
        now,
      }),
    [stream.status, stream.connected, runningSubAgents, background, loops, stream.state.queued, now],
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

  /** Nombre de lignes montées, en partant de la fin. Voir `thread-window`. */
  const [windowSize, setWindowSize] = useState(INITIAL_WINDOW_ROWS)
  /** Position du fil avant un dépliage, pour la reposer une fois le début inséré. */
  const scrollAnchor = useRef<{ height: number; top: number } | null>(null)
  /** Tour visé alors qu'il n'était pas monté : le saut part une fois qu'il l'est. */
  const pendingJump = useRef<string | null>(null)

  // Une autre conversation repart de la fin, sinon elle s'ouvrirait dépliée d'autant de
  // lignes que la précédente, sans rapport avec sa propre longueur.
  //
  // Avant peinture, et `placed` avec : la page n'est pas remontée d'un fil à l'autre,
  // donc au premier rendu du nouvel identifiant le fil précédent est encore monté, à sa
  // position, et se donnerait à voir le temps d'une image sous le nouveau titre.
  useLayoutEffect(() => {
    setWindowSize(INITIAL_WINDOW_ROWS)
    setPlaced(false)
  }, [conversationId])

  const view = useMemo(
    // La recherche dans le fil parcourt le DOM : avec une fenêtre, elle chercherait
    // dans un fil tronqué et annoncerait moins d'occurrences qu'il n'y en a. Tant
    // qu'elle est ouverte, tout est monté.
    () => windowRows(rows, findOpen ? Number.POSITIVE_INFINITY : windowSize),
    [rows, windowSize, findOpen],
  )

  /** Monte une ligne restée avant la fenêtre. Faux si elle n'est pas dans le fil. */
  const reveal = useCallback(
    (itemId: string) => {
      const needed = windowToReveal(rows, itemId)
      if (needed === null) return false
      setWindowSize((size) => Math.max(size, needed))
      return true
    },
    [rows],
  )

  const showEarlier = useCallback(() => {
    const node = scroller.current
    if (node) scrollAnchor.current = { height: node.scrollHeight, top: node.scrollTop }
    setWindowSize((size) => size + WINDOW_STEP_ROWS)
  }, [])

  /** Message visé par un résultat de recherche, une fois le fil chargé. */
  const [searchParams] = useSearchParams()
  const anchorSeq = Number(searchParams.get('seq'))
  const hasAnchor = Number.isInteger(anchorSeq) && anchorSeq > 0
  const anchored = useRef<number | null>(null)
  const activity = describeActivity(stream.state)
  const sidebarHidden = useSidebarHidden()
  const panel = usePanelPresence()
  // Le fil entier accepte les fichiers, pas seulement la barre de saisie : c'est sur la
  // conversation qu'on lâche une capture d'écran, et viser un champ de 40 pixels de haut
  // au doigt ou à la souris n'a rien d'évident.
  const drop = useFileDrop(conversation !== undefined && conversation.userId === user?.id)

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

  /**
   * Retient l'endroit lu, pour rouvrir la conversation là où on l'a laissée.
   *
   * Le repère est le message le plus haut affiché : les éléments sont dans l'ordre du
   * document, donc le dernier dont le sommet est passé au-dessus du bord est celui
   * qu'on est en train de lire. Aucun au-dessus veut dire qu'on est avant le premier
   * message, et le premier fait alors l'affaire.
   */
  const rememberScroll = useCallback(
    (node: HTMLElement) => {
      if (!conversationId) return

      const top = node.scrollTop
      if (node.scrollHeight - top - node.clientHeight < STICKY_THRESHOLD_PX) {
        saveThreadScroll(conversationId, { atBottom: true, seq: 0, offset: 0 })
        return
      }

      let anchor: HTMLElement | null = null
      for (const element of node.querySelectorAll<HTMLElement>('[data-seq]')) {
        if (anchor && element.offsetTop > top) break
        anchor = element
      }
      if (!anchor) return

      const seq = Number(anchor.dataset.seq)
      if (!Number.isInteger(seq)) return
      saveThreadScroll(conversationId, { atBottom: false, seq, offset: anchor.offsetTop - top })
    },
    [conversationId],
  )

  const onScroll = useCallback(() => {
    const node = scroller.current
    // Tant que le fil se construit, ses hauteurs bougent à chaque paquet replié et le
    // collage se repose à chaque fois : les événements de défilement qui en découlent
    // ne disent rien de l'intention de qui lit, et les prendre pour tels décollait le
    // fil de son bas avant même qu'il ne s'affiche.
    if (!node || !placed) return

    const distance = node.scrollHeight - node.scrollTop - node.clientHeight
    setStuckToBottom(distance < STICKY_THRESHOLD_PX)

    if (visibilityFrame.current !== null) return
    visibilityFrame.current = requestAnimationFrame(() => {
      visibilityFrame.current = null
      syncVisibleTurns()
      rememberScroll(node)
    })
  }, [syncVisibleTurns, rememberScroll, placed])

  const jumpToTurn = useCallback(
    (id: string) => {
      const node = scroller.current
      if (!node) return

      const anchor = turnAnchors.current.get(id)
      // La réglette liste tous les tours, y compris ceux restés avant la fenêtre : on
      // les monte, et le saut repart de l'effet de mise en page une fois l'ancre posée.
      if (!anchor) {
        if (reveal(id)) pendingJump.current = id
        return
      }

      // `scrollTo` plutôt que `scrollIntoView` : ce dernier fait aussi défiler les
      // conteneurs parents, donc la page entière sur mobile.
      node.scrollTo({ top: anchor.offsetTop - 12, behavior: 'smooth' })
      // Sur un fil dense, arriver quelque part sans savoir où l'on a atterri ne vaut
      // guère mieux que de ne pas s'être déplacé : le message atteint se signale.
      setFlashed(id)
    },
    [reveal],
  )

  // Saut différé le temps que le tour visé soit monté, et repositionnement du fil
  // après un dépliage. Les deux sont des corrections de défilement à faire avant
  // peinture, sinon le fil part au mauvais endroit puis se rattrape à l'écran.
  useLayoutEffect(() => {
    const node = scroller.current
    if (!node) return

    const jump = pendingJump.current
    if (jump) {
      const anchor = turnAnchors.current.get(jump)
      if (!anchor) return
      pendingJump.current = null
      // Sans animation : le tour vient d'apparaître, et l'y faire glisser depuis une
      // position qui n'existait pas au clic ne montre rien d'utile.
      node.scrollTo({ top: anchor.offsetTop - 12 })
      setFlashed(jump)
      return
    }

    const saved = scrollAnchor.current
    if (!saved) return
    scrollAnchor.current = null
    node.scrollTop = saved.top + (node.scrollHeight - saved.height)
  }, [view.rows])

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
      // `data-panel` plutôt que l'`aria-label` : celui-ci est traduit, et une
      // langue changée ne doit pas casser ce repérage.
      const target = event.target
      if (target instanceof Element && target.closest('[data-panel="workspace"]')) return

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
   * Monte un message resté avant la fenêtre, par son `seq`.
   *
   * Rend vrai seulement si la fenêtre grandit vraiment, donc si un rendu suivra. C'est
   * ce que demandent les deux placements d'ouverture ci-dessous : ils gardent le fil
   * masqué le temps que la cible soit montée, et une attente que rien ne réveillerait
   * le laisserait invisible pour de bon.
   */
  const growWindowTo = useCallback(
    (seq: number): boolean => {
      const target = stream.state.items.find(
        (item) => item.kind === 'message' && item.seq === seq,
      )
      if (!target) return false
      const needed = windowToReveal(rows, target.id)
      if (needed === null || needed <= windowSize) return false
      setWindowSize(needed)
      return true
    },
    [stream.state.items, rows, windowSize],
  )

  /**
   * Ouverture sur un message précis, quand on arrive depuis la recherche.
   *
   * Le journal est chargé en entier, donc le message est déjà dans le fil, mais pas
   * forcément monté : la cible peut être restée avant la fenêtre, auquel cas on la
   * dévoile et l'effet repasse au rendu suivant. Une seule fois par cible, sinon chaque
   * événement reçu ramènerait le défilement au même endroit pour le reste de la session.
   */
  useLayoutEffect(() => {
    const node = scroller.current
    // `conversation` pour la même raison que le placement ci-dessous : c'est elle qui
    // décide que le fil est monté, donc qu'il y a un nœud à mesurer.
    if (stream.loading || !conversation || !node) return
    if (!hasAnchor || anchored.current === anchorSeq) return
    if (growWindowTo(anchorSeq)) return

    // Marquée avant de savoir si la cible existe : le journal est entièrement replié à
    // ce stade, donc un message introuvable ne viendra plus, et laisser la cible en
    // attente retiendrait indéfiniment l'affichage du fil.
    anchored.current = anchorSeq

    const element = node.querySelector<HTMLElement>(`[data-seq="${anchorSeq}"]`)
    if (!element) return

    node.scrollTo({ top: element.offsetTop - 12 })
    const target = stream.state.items.find(
      (item) => item.kind === 'message' && item.seq === anchorSeq,
    )
    if (target) setFlashed(target.id)
  }, [anchorSeq, hasAnchor, stream.loading, stream.state.items, conversation, growWindowTo])

  /**
   * Place le fil à son ouverture, puis le donne à voir.
   *
   * Une seule fois par conversation, une fois le journal replié en entier : c'est la
   * seule position qui ait un sens, celles d'avant portant sur un fil encore en train
   * de se construire. Tant que ce n'est pas fait, `placed` garde le fil masqué.
   */
  useLayoutEffect(() => {
    const node = scroller.current
    // La conversation, et pas seulement son identifiant : le fil n'est rendu qu'une fois
    // ses métadonnées connues, et un journal replié avant elles laisserait cet effet
    // sans nœud à mesurer, sans que rien ne le rappelle une fois le fil monté.
    if (placed || stream.loading || !conversationId || !conversation || !node) return

    /**
     * Pose la position d'ouverture, `null` valant le bas du fil, et lève le masque.
     *
     * Le collage est relu sur le résultat plutôt que déduit de l'intention : une
     * position d'avant peut se retrouver au bas d'un fil qui a peu grandi, et l'annoncer
     * décollé afficherait la flèche de retour en bas alors qu'on y est.
     */
    const settle = (top: number | null) => {
      if (top === null) scrollToBottom(node)
      else node.scrollTop = top
      setStuckToBottom(node.scrollHeight - node.scrollTop - node.clientHeight < STICKY_THRESHOLD_PX)
      setPlaced(true)
    }

    // La recherche l'emporte : ouvrir un fil depuis un résultat doit montrer le
    // résultat, pas l'endroit d'une lecture précédente. L'effet ci-dessus l'a placé,
    // il ne reste qu'à en tirer le collage et à lever le masque.
    if (hasAnchor) {
      if (anchored.current === anchorSeq) settle(node.scrollTop)
      return
    }

    const saved = readThreadScroll(conversationId)
    if (saved.atBottom) {
      settle(null)
      return
    }

    // Le message repéré peut être resté avant la fenêtre : on l'y ramène et le
    // placement reprend au rendu suivant, toujours masqué.
    if (growWindowTo(saved.seq)) return

    const element = node.querySelector<HTMLElement>(`[data-seq="${saved.seq}"]`)
    // Plus dans le fil : compacté, forké, effacé. Le bas reste le bon défaut.
    settle(element ? element.offsetTop - saved.offset : null)
  }, [placed, stream.loading, conversationId, conversation, hasAnchor, anchorSeq, growWindowTo])

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
  const step = useCallback(
    (direction: -1 | 1) => {
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

      if (target) {
        jumpToTurn(target.id)
        return
      }

      // Plus rien au-dessus dans ce qui est monté, mais le fil continue avant la
      // fenêtre : sans ce relais, la flèche s'arrêterait au premier tour affiché comme
      // si la conversation commençait là.
      if (direction === -1 && view.hidden > 0) {
        const first = anchors[0]
        const index = first ? turns.findIndex((turn) => turn.id === first.id) : turns.length
        const previous = turns[index - 1]
        if (previous) jumpToTurn(previous.id)
      }
    },
    [jumpToTurn, turns, view.hidden],
  )

  // Défilement avant peinture : sinon le fil saute visiblement à chaque delta.
  //
  // Rien tant que le fil n'est pas placé : cet effet est déclaré après le placement,
  // donc il passerait après lui dans la même vague, avec un `stuckToBottom` d'avant, et
  // renverrait au bas du fil la position de lecture qu'on vient tout juste de rétablir.
  useLayoutEffect(() => {
    if (!placed || !stuckToBottom) return
    const node = scroller.current
    if (node) scrollToBottom(node)
  }, [stream.state.items, stream.state.lastSeq, stuckToBottom, placed])

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
      if (stuckToBottom && node) scrollToBottom(node)
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
        setActionError(err instanceof Error ? err.message : t('conversation.fork.error'))
      } finally {
        setForking(false)
      }
    },
    [conversationId, navigate, queryClient, t],
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
      setActionError(err instanceof Error ? err.message : t('conversation.compact.error'))
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
        {...drop.handlers}
      >
        {/* Voile de dépôt, en surimpression et sans capter le pointeur : intercaler une
            couche cliquable interromprait le glissement qu'elle annonce. */}
        {drop.dragging ? (
          <div
            className={cx(
              'pointer-events-none absolute inset-2 z-30 flex items-center justify-center',
              'rounded-xl border-2 border-dashed border-accent bg-canvas/80 text-sm text-accent',
            )}
          >
            {t('conversation.drop.attach')}
          </div>
        ) : null}

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
                title={
                  worktree
                    ? t('conversation.meta.worktree', { name: worktree.name })
                    : t('conversation.meta.projectFolder')
                }
              >
                {worktree ? worktree.name : t('conversation.meta.project')}
              </Meta>

              {/* Une branche dit d'où elle vient : sans ça, deux fils presque identiques
                  dans la sidebar sont impossibles à distinguer. Le lien disparaît si
                  l'originale a été supprimée, la référence devenant orpheline. */}
              {origin ? (
                <Link
                  to={`/p/${origin.projectId}/c/${origin.id}`}
                  className="flex shrink-0 items-center gap-1 rounded-full bg-surface-high px-1.5 py-0.5 hover:text-ink"
                  title={t('conversation.meta.branchOf', { title: origin.title })}
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
            aria-label={metaOpen ? t('conversation.meta.hide') : t('conversation.meta.show')}
            className="flex size-9 shrink-0 items-center justify-center rounded-md text-ink-faint md:hidden"
          >
            <ChevronDown size={16} className={cx('transition-transform', metaOpen && 'rotate-180')} />
          </button>

          {/*
            L'en-tête ne garde que ce qui invalide la lecture en cours : une erreur, un
            tour interrompu, une liaison coupée. Le reste vit au-dessus du composer, qui
            est visible en même temps que lui, et le répéter ici l'afficherait deux fois.
          */}
          <SignalRow signals={signals.filter((signal) => HEADER_SIGNALS.has(signal.kind))} />

          {/* La consommation appartient au compte, pas à la conversation : le panneau
              reste le même quel que soit le fil ouvert. */}
          <button
            type="button"
            onClick={() => setUsageOpen(true)}
            title={t('conversation.usage.title')}
            className={cx(
              'flex shrink-0 items-center gap-1.5 rounded-full border border-line',
              'bg-surface-high px-2 py-1 text-[0.6875rem] font-medium text-ink-soft',
              'transition-colors hover:border-line-strong hover:text-ink',
            )}
          >
            <GaugeCircle size={13} />
            {/* Réduit à son icône au doigt : la consommation doit rester joignable
                depuis un téléphone, c'est le libellé qui prend la place, pas le bouton. */}
            <span className="hidden md:inline">{t('conversation.usage.label')}</span>
          </button>

          {/* Sur grand écran les deux actions sont posées directement : elles sont peu
              nombreuses, et un menu qui n'en cache que deux coûte un clic pour rien.
              Au doigt la place manque, elles repassent derrière les trois points.

              Lire une conversation partagée donne le droit d'y chercher : seule la
              compaction touche à l'état du fil, et elle reste au propriétaire. */}
          <span className="hidden md:contents">
            <IconButton label={t('conversation.search')} onClick={() => setFindOpen(true)}>
              <Search size={18} />
            </IconButton>
            {isOwner ? (
              <IconButton
                label={
                  compacting || stream.state.compacting
                    ? t('conversation.compact.running')
                    : t('conversation.compact.action')
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
                <IconButton label={t('conversation.actions')}>
                  <MoreHorizontal size={18} />
                </IconButton>
              }
            >
              <MenuItem icon={<Search size={14} />} onSelect={() => setFindOpen(true)}>
                {t('conversation.search')}
              </MenuItem>
              {isOwner ? (
                <MenuItem
                  icon={<Shrink size={14} />}
                  disabled={compacting || stream.state.compacting || stream.status !== 'idle'}
                  onSelect={() => void compact()}
                >
                  {compacting || stream.state.compacting
                    ? t('conversation.compact.running')
                    : t('conversation.compact.action')}
                </MenuItem>
              ) : null}
            </Menu>
          </span>

          {/* Tout à droite, contre le bord : c'est le panneau qu'il ouvre, et il doit
              se trouver du côté où celui-ci apparaît. Le panneau appartient à la
              conversation, il lit le répertoire de travail de ce fil, worktree
              compris, pas celui du projet. */}
          <IconButton
            label={panel.open ? t('conversation.panel.close') : t('conversation.panel.open')}
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
          {/* Masqué et non démonté tant que le fil n'est pas placé : le placement se
              fait sur des hauteurs mesurées, qu'un fil absent de la mise en page
              n'aurait pas. L'apparition est fondue, la disparition immédiate : au
              changement de conversation, ce qui s'efface est le fil précédent. */}
          <div
            className={cx(
              'mx-auto flex max-w-3xl flex-col gap-3 p-3 md:p-6 @min-[40rem]:px-12',
              placed ? 'opacity-100 transition-opacity duration-200' : 'opacity-0',
            )}
          >
            {stream.error ? <Banner>{stream.error}</Banner> : null}
            {actionError ? <Banner>{actionError}</Banner> : null}

            {!stream.loading && stream.state.items.length === 0 ? (
              <EmptyState
                title={t('conversation.empty.title')}
                description={t('conversation.empty.description')}
              />
            ) : null}

            {view.hidden > 0 ? (
              <button
                type="button"
                onClick={showEarlier}
                className={cx(
                  'surface mx-auto rounded-full border border-line px-3 py-1.5',
                  'text-xs text-ink-soft transition-colors hover:text-ink',
                )}
              >
                {t(
                  view.hidden > 1
                    ? 'conversation.thread.earlier.other'
                    : 'conversation.thread.earlier.one',
                  { count: view.hidden },
                )}
              </button>
            ) : null}

            <ChatThread
              rows={view.rows}
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

        {/* Avec le fil : une réglette qui se remplit toute seule à côté d'un fil vide
            montre la construction que le masquage vient d'épargner. */}
        {placed ? (
          <ConversationMinimap
            turns={turns}
            visibleIds={visibleTurns}
            agentLabel={AGENT_LABELS[conversation.agent]}
            onJump={jumpToTurn}
          />
        ) : null}

        {/* Les commandes de défilement se posent juste au-dessus de la barre de saisie,
            dont la hauteur varie : `bottom-full` sur ce conteneur les y ancre sans
            dépendre d'un décalage fixe. Elles ne servent qu'une fois le fil quitté du
            bas, donc elles disparaissent quand on y est revenu. */}
        <div className="relative shrink-0">
          {placed && !stuckToBottom ? (
            <>
              <button
                type="button"
                onClick={() => {
                  const node = scroller.current
                  if (node) scrollToBottom(node)
                  setStuckToBottom(true)
                }}
                className={cx(
                  'absolute bottom-full left-1/2 z-10 mb-2 -translate-x-1/2',
                  'surface rounded-full border border-line p-2 text-ink-soft shadow-float',
                )}
                aria-label={t('conversation.scroll.bottom')}
              >
                <ArrowDown size={16} />
              </button>

              <div className="absolute right-3 bottom-full z-10 mb-2">
                <TurnNav count={turns.length} onStep={step} />
              </div>
            </>
          ) : null}

          {/*
            Au-dessus de la barre de saisie et non sous elle : c'est la dernière chose
            qu'on lit avant d'écrire. Aligné sur la largeur du composer pour que les deux
            forment un bloc. `TurnActivity` dit la même activité un peu plus haut, mais
            depuis le fil, donc il sort de l'écran dès qu'on remonte ; cette rangée reste.
          */}
          <SignalRow
            signals={signals}
            onSelect={() => setPanelOpen(true)}
            className="mx-auto max-w-3xl px-1.5 pb-2"
          />

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
            background={background}
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
