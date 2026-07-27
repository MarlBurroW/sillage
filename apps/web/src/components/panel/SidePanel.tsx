import { FileCode, FolderTree, GitCompare, RefreshCw, SquareTerminal, X } from 'lucide-react'
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react'
import type { EditTurn } from '../../lib/chat-fold'
import { openTab } from '../../lib/editor-tabs'
import { restorePanelWidth, setPanelOpen, setPanelWidth } from '../../lib/panel'
import { useRefreshTree } from '../../lib/tree'
import { IconButton, cx } from '../ui'
import { ChangesPane } from './ChangesPane'
import { EditorPane } from './EditorPane'
import { FileTree } from './FileTree'
import { TerminalsPane } from './TerminalsPane'

/**
 * Panneau latéral droit.
 *
 * Troisième colonne sur grand écran, vue plein écran au doigt : il ne peut pas
 * coexister avec le fil dans 390 px.
 *
 * Il suit le répertoire de travail de la **conversation** ouverte, worktree compris,
 * et non la racine du projet : c'est là que l'agent écrit.
 */
export function SidePanel({
  conversationId,
  editTurns,
  turnRunning,
  open,
}: {
  conversationId: string
  editTurns: EditTurn[]
  turnRunning: boolean
  /** Faux pendant la sortie : le panneau est encore monté, mais s'en va. */
  open: boolean
}) {
  const [tab, setTab] = useState<'explorer' | 'editor' | 'changes' | 'terminals'>('explorer')
  /**
   * Le premier rendu se fait volontairement hors écran, l'entrée n'étant lancée qu'au
   * rendu suivant : un élément qui naît déjà en place n'a aucune transition à jouer,
   * et le panneau apparaîtrait d'un coup.
   */
  const [entered, setEntered] = useState(false)
  const aside = useRef<HTMLElement>(null)
  const refresh = useRefreshTree(conversationId)
  const wasRunning = useRef(turnRunning)

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
  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault()

    const move = (moved: globalThis.PointerEvent) =>
      setPanelWidth(window.innerWidth - moved.clientX, false)
    const stop = (released: globalThis.PointerEvent) => {
      setPanelWidth(window.innerWidth - released.clientX, true)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      document.body.style.removeProperty('cursor')
      document.body.style.removeProperty('user-select')
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  const resizeByKey = (event: KeyboardEvent<HTMLDivElement>) => {
    // Inversé par rapport à la sidebar : ici, aller vers la gauche élargit.
    const step = event.key === 'ArrowLeft' ? 16 : event.key === 'ArrowRight' ? -16 : 0
    if (step === 0) return

    const current = aside.current?.getBoundingClientRect().width
    if (current === undefined) return

    event.preventDefault()
    setPanelWidth(current + step, true)
  }

  return (
    <aside
      ref={aside}
      aria-label="Panneau du workspace"
      className={cx(
        // Pas d'`overflow-hidden` ici : il rognerait la poignée, posée en débord sur
        // le bord gauche. C'est la zone de défilement interne qui borne le contenu.
        'surface z-20 flex shrink-0 flex-col border-l border-line',
        // Plein écran au doigt, colonne au-delà. `absolute` et non `fixed` : le repère
        // est le calque de la coque, donc le panneau suit le viewport visuel.
        // `md:relative` et non `md:static` : la poignée se positionne par rapport au
        // panneau, et un panneau statique la renverrait sur un ancêtre. Deux
        // utilitaires de position sur le même élément se départagent par l'ordre du
        // CSS généré, jamais par celui de la chaîne de classes.
        'absolute inset-0 md:relative md:inset-auto md:w-[var(--panel-width,20rem)]',
        // Au doigt le panneau se pose par-dessus le fil : une translation suffit. Sur
        // grand écran il occupe une colonne, donc c'est aussi la marge qui doit se
        // refermer, sinon glisser ne ferait que laisser un vide de sa largeur.
        // `translate` et non `transform` : Tailwind v4 pose les utilitaires de
        // translation sur cette propriété CSS, distincte de `transform`.
        'transition-[translate,margin] duration-200 ease-out',
        entered && open
          ? 'translate-x-0 md:mr-0'
          : 'translate-x-full md:-mr-[var(--panel-width,20rem)]',
      )}
    >
      {/* Pas d'encoche haute ici : même en plein écran, le panneau se pose sous
          l'en-tête de la coque, qui la réserve déjà. La réserver deux fois creusait
          59 px de vide au milieu de l'écran. */}
      {/* `@container` : les onglets se réduisent à leurs icônes selon la largeur du
          panneau, et non celle de la fenêtre, puisqu'il se redimensionne. */}
      <header className="@container flex h-[var(--header-height)] shrink-0 items-center border-b border-line px-1.5">
        {/* La liste défile plutôt que de pousser les actions hors de l'écran : au
            doigt, quatre onglets nommés chassaient la croix de fermeture du panneau,
            qui devenait alors impossible à refermer. */}
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          <Tab
            icon={<FolderTree size={14} />}
            label="Explorateur"
            active={tab === 'explorer'}
            onSelect={() => setTab('explorer')}
          />
          <Tab
            icon={<FileCode size={14} />}
            label="Éditeur"
            active={tab === 'editor'}
            onSelect={() => setTab('editor')}
          />
          <Tab
            icon={<GitCompare size={14} />}
            label="Modifications"
            active={tab === 'changes'}
            onSelect={() => setTab('changes')}
          />
          <Tab
            icon={<SquareTerminal size={14} />}
            label="Terminaux"
            active={tab === 'terminals'}
            onSelect={() => setTab('terminals')}
          />
        </div>

        <div className="flex shrink-0 items-center gap-0.5 pl-1">
          {tab === 'explorer' ? (
            <IconButton label="Rafraîchir l'arborescence" size="sm" onClick={refresh}>
              <RefreshCw size={15} />
            </IconButton>
          ) : null}
          <IconButton label="Fermer le panneau" size="sm" onClick={() => setPanelOpen(false)}>
            <X size={17} />
          </IconButton>
        </div>
      </header>

      {/* Les deux vues restent montées : basculer sur l'éditeur ne doit pas replier
          l'arborescence ni perdre la position de défilement, et l'éditeur ne doit pas
          relire son fichier à chaque aller-retour. */}
      <div
        className={cx(
          'min-h-0 flex-1 overflow-auto py-1 pb-safe',
          tab === 'explorer' ? 'block' : 'hidden',
        )}
      >
        <FileTree conversationId={conversationId} onOpenFile={() => setTab('editor')} />
      </div>

      {/* `min-w-0` : sans lui, un enfant flex se dimensionne sur son contenu, et
          l'éditeur imposait sa largeur au panneau au lieu de défiler dedans. */}
      <div
        className={cx(
          'min-h-0 min-w-0 flex-1 overflow-hidden pb-safe',
          tab === 'editor' ? 'flex' : 'hidden',
        )}
      >
        <div className="min-h-0 min-w-0 flex-1">
          <EditorPane conversationId={conversationId} />
        </div>
      </div>

      <div
        className={cx(
          'min-h-0 min-w-0 flex-1 overflow-hidden',
          tab === 'changes' ? 'flex' : 'hidden',
        )}
      >
        <div className="min-h-0 min-w-0 flex-1">
          <ChangesPane
            conversationId={conversationId}
            editTurns={editTurns}
            turnRunning={turnRunning}
            onOpenFile={(path) => {
              openTab(conversationId, path)
              setTab('editor')
            }}
          />
        </div>
      </div>

      {/* Monté dès que le panneau existe, et non seulement quand l'onglet est actif :
          un shell qui compile ne doit pas être coupé parce qu'on regarde le diff. */}
      <div
        className={cx(
          'min-h-0 min-w-0 flex-1 overflow-hidden',
          tab === 'terminals' ? 'flex' : 'hidden',
        )}
      >
        <div className="min-h-0 min-w-0 flex-1">
          <TerminalsPane conversationId={conversationId} visible={tab === 'terminals'} />
        </div>
      </div>

      {/* Poignée de largeur sur le bord gauche, grand écran seulement : au doigt le
          panneau occupe tout l'écran, il n'y a rien à ajuster. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Largeur du panneau"
        tabIndex={0}
        onPointerDown={startResize}
        onKeyDown={resizeByKey}
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
  onSelect,
}: {
  icon: ReactNode
  label: string
  active: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={active}
      // Le nom reste porté par le bouton même quand il n'est plus écrit : une icône
      // seule ne dit pas ce qu'elle ouvre, ni à l'œil ni à un lecteur d'écran.
      aria-label={label}
      title={label}
      className={cx(
        'flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors',
        active ? 'bg-accent-wash text-ink' : 'text-ink-faint hover:text-ink',
      )}
    >
      <span className="shrink-0">{icon}</span>
      {/* Les quatre noms demandent ~470 px, que ni un téléphone ni la largeur par
          défaut du panneau n'offrent : en dessous, seul l'onglet actif garde le sien,
          ce qui dit où l'on est sans que la liste ait à défiler. */}
      <span className={cx(active ? '' : '@max-[30rem]:hidden')}>{label}</span>
    </button>
  )
}
