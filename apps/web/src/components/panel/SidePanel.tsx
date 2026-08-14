import {
  Bot,
  FileCode,
  GitCompare,
  History,
  PanelLeft,
  PlugZap,
  RefreshCw,
  SquareTerminal,
  X,
} from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AgentKind, McpServerStatus } from '@sillage/protocol'
import type { BackgroundWork } from '../../lib/background'
import type { EditTurn } from '../../lib/chat-fold'
import { openTab } from '../../lib/editor-tabs'
import { useTranslate } from '../../lib/i18n'
import {
  restorePanelWidth,
  setPanelOpen,
  setPanelTab,
  setPanelTree,
  setPanelWidth,
  usePanelTab,
  usePanelTree,
  useSelectedSubAgent,
  type PanelTab,
} from '../../lib/panel'
import { projectScope } from '../../lib/workspace-scope'
import { resizeHandle } from '../../lib/resize-handle'
import type { SubAgent } from '../../lib/subagents'
import { useRefreshTree } from '../../lib/tree'
import { IconButton, cx } from '../ui'
import { AgentsPane } from './AgentsPane'
import { FilesPane } from './FilesPane'
import { GitPane } from './GitPane'
import { HistoryPane } from './HistoryPane'
import { McpPane } from './McpPane'
import { TerminalsPane } from './TerminalsPane'

/**
 * Panneau latéral droit.
 *
 * Posé au-dessus du fil et non à côté, sur grand écran comme au doigt. Il s'ouvre
 * large, parce que ce qu'on y fait tient mal dans une colonne : une arborescence et
 * un éditeur côte à côte, un diff, un terminal. Prendre cette place à même la mise en
 * page réduisait le fil à rien ; l'en recouvrir la lui rend dès qu'on referme.
 *
 * Ni voile ni fermeture au clic extérieur : ce n'est pas une boîte de dialogue, il
 * tient des terminaux vivants et un contenu en cours d'édition, et un clic mal placé
 * ne doit pas les emporter.
 *
 * En vue conversation, il suit le répertoire de travail du fil, worktree compris :
 * c'est là que l'agent écrit. En vue projet (Board, brouillon), aucune conversation
 * n'existe : Fichiers, Git et Terminaux opèrent sur le workspace du projet, et les
 * onglets propres à une session (Historique, Agents, MCP) ne sont pas proposés.
 */
export function SidePanel({
  projectId,
  conversationId,
  agent,
  editTurns = [],
  turnRunning = false,
  subAgents = [],
  background = [],
  mcpServers = [],
  open,
}: {
  projectId: string
  /** Absente en vue projet : le panneau se réduit alors aux onglets de répertoire. */
  conversationId?: string
  /** CLI de la conversation, pour les gestes que seuls certains CLI savent faire. */
  agent?: AgentKind
  editTurns?: EditTurn[]
  turnRunning?: boolean
  subAgents?: SubAgent[]
  background?: BackgroundWork[]
  mcpServers?: McpServerStatus[]
  /** Faux pendant la sortie : le panneau est encore monté, mais s'en va. */
  open: boolean
}) {
  // L'onglet vit hors du panneau : le fil le pilote, en ouvrant un fichier depuis un
  // diff comme en désignant un sous-agent depuis le bandeau.
  const t = useTranslate()
  const scope = conversationId ?? projectScope(projectId)
  const chosenTab = usePanelTab()
  // L'onglet choisi survit d'une vue à l'autre ; en vue projet, un onglet de session
  // retombe sur les fichiers plutôt que d'afficher un panneau vide.
  const tab: PanelTab =
    conversationId || !['history', 'agents', 'mcp'].includes(chosenTab) ? chosenTab : 'files'
  const treeOpen = usePanelTree()
  const selectedSubAgent = useSelectedSubAgent()
  /**
   * Le premier rendu se fait volontairement hors écran, l'entrée n'étant lancée qu'au
   * rendu suivant : un élément qui naît déjà en place n'a aucune transition à jouer,
   * et le panneau apparaîtrait d'un coup.
   */
  const [entered, setEntered] = useState(false)
  const aside = useRef<HTMLElement>(null)
  const refresh = useRefreshTree(scope)
  const wasRunning = useRef(turnRunning)

  /** Ouvrir un fichier depuis un diff : l'onglet naît sous les yeux de qui l'a demandé. */
  const openInFiles = (path: string) => {
    openTab(scope, path)
    setPanelTab('files')
  }

  useEffect(restorePanelWidth, [])

  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  /**
   * Rafraîchi à la **fin** d'un tour, moment où l'arborescence a réellement bougé,
   * plutôt qu'en boucle. Pendant le tour, les fichiers changent à chaque écriture et
   * relire à chaque événement ferait clignoter la liste sans rien apprendre.
   */
  useEffect(() => {
    if (wasRunning.current && !turnRunning) refresh()
    wasRunning.current = turnRunning
  }, [turnRunning, refresh])

  /**
   * Le panneau est collé au bord droit de la fenêtre : sa largeur vaut donc la
   * distance du pointeur à ce bord, sans décalage à mémoriser au début du geste.
   */
  const handle = resizeHandle({
    widthAt: (clientX) => window.innerWidth - clientX,
    current: () => aside.current?.getBoundingClientRect().width ?? null,
    apply: setPanelWidth,
  })

  return (
    <aside
      ref={aside}
      aria-label={t('panel.aria')}
      // Repère stable pour le raccourci de recherche du fil, qui doit savoir si
      // l'événement vient d'ici : l'`aria-label` ci-dessus, lui, change de langue.
      data-panel="workspace"
      className={cx(
        // Pas d'`overflow-hidden` ici : il rognerait la poignée, posée en débord sur
        // le bord gauche. C'est la zone de défilement interne qui borne le contenu.
        // L'ombre porte le décollement : sans elle, un panneau posé sur le fil se lit
        // comme une colonne de plus, et on cherche pourquoi le fil est coupé.
        'surface z-20 flex flex-col border-l border-line shadow-pop',
        // Plein écran au doigt, largeur réglable au-delà. `absolute` et non `fixed` :
        // le repère est le calque de la coque, donc le panneau suit le viewport visuel.
        // La largeur est bornée en CSS et pas seulement à l'enregistrement : une
        // fenêtre rétrécie après coup laisserait sinon un panneau plus large qu'elle.
        'absolute inset-0 md:left-auto md:w-[min(var(--panel-width,45rem),calc(100vw-10rem))]',
        // `translate` et non `transform` : Tailwind v4 pose les utilitaires de
        // translation sur cette propriété CSS, distincte de `transform`.
        'transition-[translate] duration-200 ease-out',
        entered && open ? 'translate-x-0' : 'translate-x-full',
      )}
    >
      {/* Pas d'encoche haute ici : même en plein écran, le panneau se pose sous
          l'en-tête de la coque, qui la réserve déjà. La réserver deux fois creusait
          59 px de vide au milieu de l'écran. */}
      {/* `@container` : les onglets se réduisent à leurs icônes selon la largeur du
          panneau, et non celle de la fenêtre, puisqu'il se redimensionne. */}
      <header className="@container flex h-[var(--header-height)] shrink-0 items-center border-b border-line px-1.5">
        {/* La liste défile plutôt que de pousser les actions hors de l'écran : au
            doigt, les onglets nommés chassaient la croix de fermeture du panneau,
            qui devenait alors impossible à refermer. */}
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          <Tab
            icon={<FileCode size={14} />}
            label={t('panel.tab.files')}
            active={tab === 'files'}
            onSelect={() => setPanelTab('files')}
          />
          <Tab
            icon={<GitCompare size={14} />}
            label={t('panel.tab.git')}
            active={tab === 'git'}
            onSelect={() => setPanelTab('git')}
          />
          {conversationId ? (
            <Tab
              icon={<History size={14} />}
              label={t('panel.tab.history')}
              active={tab === 'history'}
              onSelect={() => setPanelTab('history')}
            />
          ) : null}
          <Tab
            icon={<SquareTerminal size={14} />}
            label={t('panel.tab.terminals')}
            active={tab === 'terminals'}
            onSelect={() => setPanelTab('terminals')}
          />
          {conversationId ? (
            <>
              <Tab
                icon={<Bot size={14} />}
                label={t('panel.tab.agents')}
                badge={
                  subAgents.filter((agent) => agent.status === 'running').length + background.length
                }
                active={tab === 'agents'}
                onSelect={() => setPanelTab('agents')}
              />
              <Tab
                icon={<PlugZap size={14} />}
                label={t('panel.tab.mcp')}
                // Seuls les serveurs en défaut se comptent : une pastille sur un
                // inventaire sain crierait en permanence pour ne rien dire.
                badge={
                  mcpServers.filter((s) => s.state === 'failed' || s.state === 'needs-auth').length
                }
                active={tab === 'mcp'}
                onSelect={() => setPanelTab('mcp')}
              />
            </>
          ) : null}
        </div>

        <div className="flex shrink-0 items-center gap-0.5 pl-1">
          {tab === 'files' ? (
            <>
              <IconButton
                label={treeOpen ? t('panel.tree.hide') : t('panel.tree.show')}
                size="sm"
                onClick={() => setPanelTree(!treeOpen)}
              >
                <PanelLeft size={16} className={cx(treeOpen && 'text-accent')} />
              </IconButton>
              <IconButton label={t('panel.tree.refresh')} size="sm" onClick={refresh}>
                <RefreshCw size={15} />
              </IconButton>
            </>
          ) : null}
          <IconButton label={t('panel.close')} size="sm" onClick={() => setPanelOpen(false)}>
            <X size={17} />
          </IconButton>
        </div>
      </header>

      {/* Monté même quand un autre onglet est devant : revenir aux fichiers ne doit
          replier ni l'arborescence, ni perdre sa position de défilement, ni faire
          relire son fichier à l'éditeur. */}
      <div
        className={cx(
          'min-h-0 min-w-0 flex-1 overflow-hidden pb-safe',
          tab === 'files' ? 'flex' : 'hidden',
        )}
      >
        <FilesPane scope={scope} />
      </div>

      {/* Deux vues montées seulement quand on les regarde : leur contenu vient du
          journal ou d'une lecture git relancée à l'affichage, rien ne s'y perd. */}
      {tab === 'git' ? (
        <GitPane scope={scope} turnRunning={turnRunning} onOpenFile={openInFiles} />
      ) : null}

      {tab === 'history' && conversationId ? (
        <HistoryPane
          conversationId={conversationId}
          turns={editTurns}
          onOpenFile={openInFiles}
        />
      ) : null}

      {/* Monté dès que le panneau existe, et non seulement quand l'onglet est actif :
          un shell qui compile ne doit pas être coupé parce qu'on regarde le diff. */}
      <div
        className={cx(
          'min-h-0 min-w-0 flex-1 overflow-hidden',
          tab === 'terminals' ? 'flex' : 'hidden',
        )}
      >
        <div className="min-h-0 min-w-0 flex-1">
          <TerminalsPane
            projectId={projectId}
            conversationId={conversationId}
            visible={tab === 'terminals'}
          />
        </div>
      </div>

      {/* Monté seulement quand on le regarde, contrairement aux autres : il ne tient
          rien de vivant, tout son contenu vient du journal, et ses chronomètres n'ont
          rien à compter derrière un onglet fermé. */}
      {tab === 'agents' && conversationId && agent ? (
        <AgentsPane
          conversationId={conversationId}
          agent={agent}
          agents={subAgents}
          background={background}
          selectedId={selectedSubAgent}
        />
      ) : null}

      {/* Même raison que les sous-agents : son contenu vient du journal, rien ne se
          perd à ne le monter que lorsqu'on le regarde. */}
      {tab === 'mcp' ? <McpPane servers={mcpServers} /> : null}

      {/* Poignée de largeur sur le bord gauche, grand écran seulement : au doigt le
          panneau occupe tout l'écran, il n'y a rien à ajuster. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('panel.resize.aria')}
        tabIndex={0}
        onPointerDown={handle.onPointerDown}
        onKeyDown={handle.onKeyDown}
        className={cx(
          'absolute inset-y-0 -left-1 hidden w-2 cursor-col-resize md:block',
          'after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2',
          'after:transition-colors hover:after:bg-accent focus-visible:after:bg-accent',
          'outline-none',
        )}
      />
    </aside>
  )
}

function Tab({
  icon,
  label,
  active,
  badge = 0,
  onSelect,
}: {
  icon: ReactNode
  label: string
  active: boolean
  /** Décompte affiché sur l'onglet. Zéro n'affiche rien. */
  badge?: number
  onSelect: () => void
}) {
  const t = useTranslate()
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      // Le nom reste porté par le bouton même quand il n'est plus écrit : une icône
      // seule ne dit pas ce qu'elle ouvre, ni à l'œil ni à un lecteur d'écran.
      aria-label={badge > 0 ? t('panel.tab.badge', { label, count: badge }) : label}
      title={label}
      className={cx(
        'flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors',
        active ? 'bg-accent-wash text-ink' : 'text-ink-faint hover:text-ink',
      )}
    >
      <span className="shrink-0">{icon}</span>
      {/* Les noms demandent plus de place que n'en offrent un téléphone ou la largeur
          par défaut du panneau : en dessous, seul l'onglet actif garde le sien, ce qui
          dit où l'on est sans que la liste ait à défiler. */}
      <span className={cx(active ? '' : '@max-[34rem]:hidden')}>{label}</span>
      {/* Le décompte, lui, ne se replie jamais : c'est ce qui signale une activité
          dont on ne verrait sinon aucune trace, l'onglet étant fermé. */}
      {badge > 0 ? (
        <span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-accent text-[0.625rem] font-semibold text-accent-ink">
          {badge}
        </span>
      ) : null}
    </button>
  )
}
