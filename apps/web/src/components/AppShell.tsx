import {
  DndContext,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers'
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  Archive,
  ArchiveRestore,
  ChevronRight,
  FolderPlus,
  ListTree,
  LogOut,
  Menu as MenuIcon,
  MoreHorizontal,
  Palette,
  PanelLeft,
  PanelLeftClose,
  Pencil,
  Search,
  Settings,
  SlidersHorizontal,
  Trash2,
  Users,
  X,
} from 'lucide-react'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { NavLink, useMatch, useNavigate } from 'react-router-dom'
import { Outlet } from 'react-router-dom'
import type { ConversationDto, ConversationMetrics, ProjectDto } from '@sillage/protocol'
import {
  useAllConversations,
  useArchiveConversation,
  useDeleteConversation,
  useRenameConversation,
  useReorderConversations,
} from '../lib/conversations'
import {
  useLiveBackground,
  useLiveLoops,
  useLiveMetrics,
  useLiveSeq,
  useLiveStatus,
  useStatusFeed,
} from '../lib/conversation-status'
import { isUnread, useHasUnread } from '../lib/reads'
import { buildSidebarSignals, presentSignal } from '../lib/signals'
import { SignalDot } from './chat/Signals'
import { useProjects, useReorderProjects, useUpdateProject } from '../lib/projects'
import {
  restoreSidebarWidth,
  setSidebarDetailed,
  setSidebarHidden,
  setSidebarWidth,
  useSidebarDetailed,
  useSidebarHidden,
} from '../lib/sidebar'
import { formatBytes } from '../lib/attachments'
import { formatTokens } from '../lib/tokens'
import { useFileDropGuard } from '../lib/file-drop'
import { useTranslate } from '../lib/i18n'
import { useVisualViewport } from '../lib/viewport'
import { PROJECT_COLORS } from '../lib/project-colors'
import { useCurrentUser, useLogout } from '../lib/session'
import { AgentIcon } from './AgentIcon'
import { CommandPalette } from './CommandPalette'
import { Logo } from './Logo'
import { UpdatePrompt } from './UpdatePrompt'
import {
  IconButton,
  Menu,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuSwatch,
  MenuSwatchRow,
  cx,
} from './ui'

/** Le raccourci porte la touche que la plateforme utilise réellement. */
const SEARCH_HINT = navigator.userAgent.includes('Mac') ? '⌘ K' : 'Ctrl K'

/**
 * Neutralise le clic qui suit immédiatement un glisser-déposer.
 *
 * L'écouteur est posé en phase de capture pour passer avant le lien, et retiré au
 * tour de boucle suivant : si le glissement n'a produit aucun clic, il ne doit surtout
 * pas manger le clic légitime d'après.
 */
function swallowNextClick(): void {
  const swallow = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
  }

  window.addEventListener('click', swallow, { capture: true, once: true })
  setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0)
}

/**
 * Champ de renommage, ouvert par double-clic sur le nom.
 *
 * Le texte est sélectionné à l'ouverture : renommer part presque toujours d'un nom
 * proposé par le CLI qu'on remplace, et le curseur posé en fin de ligne obligeait à
 * tout effacer à la main.
 */
function RenameInput({
  value,
  onCommit,
  onCancel,
  className,
}: {
  value: string
  onCommit: (next: string) => void
  onCancel: () => void
  className: string
}) {
  const [draft, setDraft] = useState(value)

  return (
    <input
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => onCommit(draft)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') onCommit(draft)
        if (event.key === 'Escape') onCancel()
      }}
      className={className}
    />
  )
}

/**
 * Souris : un seuil de déplacement, pour que le clic sur un lien reste un clic.
 * Tactile : un appui long, sinon le glissement volerait le défilement de la liste.
 */
function useDragSensors() {
  return useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  )
}

/**
 * Desktop : sidebar persistante. Mobile : la même sidebar en tiroir plein écran.
 * Un seul composant de navigation, deux présentations.
 */
export function AppShell() {
  const t = useTranslate()
  const [navOpen, setNavOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const hidden = useSidebarHidden()
  const aside = useRef<HTMLElement>(null)
  useVisualViewport()
  useFileDropGuard()

  useEffect(restoreSidebarWidth, [])

  // Raccourci global : la palette doit s'ouvrir depuis n'importe quelle vue, y compris
  // avec le curseur dans la barre de saisie.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'k') return
      event.preventDefault()
      setSearchOpen((value) => !value)
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  /**
   * La sidebar commence au bord gauche de la fenêtre : l'abscisse du pointeur est donc
   * la largeur voulue, sans décalage à mémoriser au début du geste.
   */
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()

    const move = (moved: PointerEvent) => setSidebarWidth(moved.clientX, false)
    const stop = (released: PointerEvent) => {
      setSidebarWidth(released.clientX, true)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      document.body.style.removeProperty('cursor')
      document.body.style.removeProperty('user-select')
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    // Sans ça, le glissement sélectionne les noms de conversations au passage et le
    // curseur redevient une flèche dès qu'on quitte la poignée.
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  const resizeByKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.key === 'ArrowLeft' ? -16 : event.key === 'ArrowRight' ? 16 : 0
    if (step === 0) return

    const current = aside.current?.getBoundingClientRect().width
    if (current === undefined) return

    event.preventDefault()
    setSidebarWidth(current + step, true)
  }

  return (
    /**
     * Calque fixe de l'application, dimensionné par `.app-layer`.
     *
     * À l'ouverture du clavier, il se cale sur le viewport visuel et remonte de
     * `--sg-viewport-top` : le clavier pousse tout vers le haut au lieu de recouvrir la
     * barre de saisie.
     */
    <div className="app-layer flex overflow-hidden text-ink">
      <aside
        ref={aside}
        className={cx(
          // `absolute` et non `fixed` : le repère est le calque ci-dessus, donc le
          // tiroir suit le viewport visuel au lieu de passer sous le clavier.
          'absolute inset-y-0 left-0 z-30 w-[var(--sidebar-width)] shrink-0',
          'md:w-[var(--sidebar-desktop-width)]',
          'surface border-r border-line pt-safe',
          // Sur mobile, la sidebar est en surimpression : une translation suffit à la
          // faire entrer et sortir. Sur grand écran elle occupe une colonne du flex,
          // donc c'est la marge qui doit se refermer, sinon translater ne ferait que
          // laisser un vide de sa largeur.
          // `translate` et non `transform` : Tailwind v4 pose les utilitaires de
          // translation sur la propriété CSS `translate`, qui est distincte. Une
          // transition déclarée sur `transform` ne portait donc sur rien, et le
          // tiroir sautait d'un bord à l'autre sur mobile.
          'transition-[translate,margin] duration-200 ease-out',
          // `md:left-auto` : en `sticky`, un `left: 0` réépingle l'élément au bord du
          // viewport et annule visuellement la marge négative du repli, alors même
          // que la place, elle, est bien rendue.
          'md:relative md:h-full md:translate-x-0',
          navOpen ? 'translate-x-0' : '-translate-x-full',
          hidden ? 'md:-ml-[var(--sidebar-desktop-width)]' : 'md:ml-0',
        )}
      >
        <Sidebar
          onNavigate={() => setNavOpen(false)}
          onClose={() => setNavOpen(false)}
          onCollapse={() => setSidebarHidden(true)}
          onSearch={() => {
            setNavOpen(false)
            setSearchOpen(true)
          }}
        />

        {/* Poignée de largeur, sur le bord droit. Retirée quand la sidebar est repliée :
            elle se retrouverait sinon au bord gauche de la vue, par-dessus le bouton de
            réaffichage, à redimensionner quelque chose d'invisible. */}
        {hidden ? null : (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label={t('shell.nav.resize.aria')}
            tabIndex={0}
            onPointerDown={startResize}
            onKeyDown={resizeByKey}
            className={cx(
              'absolute inset-y-0 -right-1 z-10 hidden w-2 cursor-col-resize md:block',
              // Le trait n'apparaît qu'au survol : au repos, la bordure de la sidebar
              // suffit, et une seconde ligne permanente la doublerait.
              'after:absolute after:inset-y-0 after:left-1/2 after:w-0.5 after:-translate-x-1/2',
              'after:transition-colors hover:after:bg-accent focus-visible:after:bg-accent',
              'outline-none',
            )}
          />
        )}
      </aside>

      {hidden ? (
        <div className="absolute top-2 left-2 z-30 hidden md:block">
          <IconButton label={t('shell.nav.show')} onClick={() => setSidebarHidden(false)}>
            <PanelLeft size={18} />
          </IconButton>
        </div>
      ) : null}

      <CommandPalette open={searchOpen} onOpenChange={setSearchOpen} />
      <UpdatePrompt />

      {navOpen ? (
        <button
          type="button"
          aria-label={t('shell.nav.close')}
          onClick={() => setNavOpen(false)}
          className="absolute inset-0 z-20 bg-black/50 backdrop-blur-[2px] md:hidden"
        />
      ) : null}

      {/* Aucune gouttière : le bouton de réaffichage se pose dans le coin haut-gauche,
          et ce sont les vues qui ont un en-tête qui lui réservent sa place
          (`useSidebarHidden`). Une colonne décalée de sa largeur laissait une bande vide
          sur toute la hauteur de l'écran. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className={cx(
            'header-bar flex shrink-0 items-center gap-1 px-2',
            'border-b border-line bg-canvas/85 backdrop-blur-md md:hidden',
          )}
        >
          <IconButton label={t('shell.nav.open')} onClick={() => setNavOpen(true)}>
            <MenuIcon size={20} />
          </IconButton>
          <Logo size={18} className="text-accent" />
          <span className="font-medium">Sillage</span>
        </header>

        {/* Le calque racine ne défile plus : chaque vue porte son propre défilement.
            Les pages de réglages n'en gèrent aucun, il leur est donné ici. */}
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  )
}

function Sidebar({
  onNavigate,
  onClose,
  onCollapse,
  onSearch,
}: {
  onNavigate: () => void
  onClose: () => void
  onCollapse: () => void
  onSearch: () => void
}) {
  const t = useTranslate()
  const { data: user } = useCurrentUser()
  const { data: projects } = useProjects()
  const { data: conversations } = useAllConversations()
  const logout = useLogout()
  const reorder = useReorderProjects()
  const sensors = useDragSensors()
  const detailed = useSidebarDetailed()
  useStatusFeed()

  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toggle = (projectId: string) =>
    setCollapsed((current) => {
      const next = new Set(current)
      if (!next.delete(projectId)) next.add(projectId)
      return next
    })

  /**
   * Pendant qu'on déplace un projet, toutes les conversations sont repliées.
   *
   * Sans ça, un projet qui en porte trente rend la liste plus haute que l'écran et le
   * glissement devient impraticable. Le repli est temporaire et n'écrase pas les
   * projets que l'utilisateur avait lui-même repliés.
   */
  const [dragging, setDragging] = useState(false)

  const onDragEnd = (event: DragEndEvent) => {
    setDragging(false)
    // Un glissement se termine par un `mouseup` sur le lien du projet, donc le
    // navigateur émet un clic juste après : sans l'avaler, réordonner ouvrirait le
    // projet déplacé.
    swallowNextClick()

    const { active, over } = event
    if (!over || active.id === over.id) return

    const ids = (projects ?? []).map((project) => project.id)
    const from = ids.indexOf(String(active.id))
    const to = ids.indexOf(String(over.id))
    if (from === -1 || to === -1) return

    reorder.mutate(arrayMove(ids, from, to))
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-[var(--header-height)] shrink-0 items-center gap-2 px-4">
        <Logo size={20} className="text-accent" />
        <span className="text-[0.9375rem] font-semibold tracking-tight">Sillage</span>
        {/* Enveloppes plutôt que `hidden` sur le bouton : `IconButton` pose déjà un
            `inline-flex`, et entre deux utilitaires de display c'est l'ordre du CSS
            généré qui tranche, pas celui de la chaîne de classes. Les deux boutons
            s'affichaient donc côte à côte sur mobile. */}
        <span className="ml-auto md:hidden">
          <IconButton label={t('shell.nav.close')} onClick={onClose}>
            <X size={18} />
          </IconButton>
        </span>
        <span className="ml-auto hidden md:block">
          <IconButton label={t('shell.nav.collapse')} onClick={onCollapse}>
            <PanelLeftClose size={18} />
          </IconButton>
        </span>
      </div>

      <div className="shrink-0 px-2 pb-1">
        {/* Le raccourci n'existe pas au doigt : sans cette entrée, la recherche serait
            inatteignable depuis un téléphone. */}
        <button
          type="button"
          onClick={onSearch}
          className={cx(
            'flex h-9 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm',
            'text-ink-soft transition-colors hover:bg-surface-high hover:text-ink',
          )}
        >
          <Search size={15} className="shrink-0" />
          <span className="flex-1">{t('shell.search')}</span>
          <kbd className="hidden shrink-0 rounded border border-line px-1 text-[0.625rem] text-ink-faint md:block">
            {SEARCH_HINT}
          </kbd>
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        <div className="flex items-center justify-between py-1 pr-1 pl-2.5">
          <span className="text-[0.6875rem] font-semibold tracking-wider text-ink-faint uppercase">
            {t('shell.projects.heading')}
          </span>
          <span className="flex items-center">
            {/* Un seul interrupteur pour toute la liste : le mode sert à comparer des
                conversations entre elles, ce qu'un dépliage ligne à ligne interdit. */}
            <IconButton
              label={detailed ? t('shell.conversations.detail.hide') : t('shell.conversations.detail.show')}
              size="sm"
              onClick={() => setSidebarDetailed(!detailed)}
              className={detailed ? 'text-accent' : undefined}
            >
              <ListTree size={15} />
            </IconButton>
            <NavLink to="/settings/projets" onClick={onNavigate} aria-label={t('shell.projects.add')}>
              <IconButton label={t('shell.projects.add')} size="sm">
                <FolderPlus size={15} />
              </IconButton>
            </NavLink>
          </span>
        </div>

        {projects && projects.length > 0 ? (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis, restrictToParentElement]}
            onDragStart={() => setDragging(true)}
            onDragEnd={onDragEnd}
            onDragCancel={() => {
              setDragging(false)
              swallowNextClick()
            }}
          >
            <SortableContext
              items={projects.map((project) => project.id)}
              strategy={verticalListSortingStrategy}
            >
              <ul className="flex flex-col gap-px">
                {projects.map((project) => (
                  <ProjectGroup
                    key={project.id}
                    project={project}
                    conversations={(conversations ?? []).filter((c) => c.projectId === project.id)}
                    open={!dragging && !collapsed.has(project.id)}
                    // Le repli voulu par l'utilisateur, que `open` ne dit pas : un
                    // glissement ferme tous les projets, et le report du non-lu
                    // s'allumerait partout le temps du déplacement.
                    collapsed={collapsed.has(project.id)}
                    onToggle={() => toggle(project.id)}
                    onNavigate={onNavigate}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        ) : (
          <p className="px-2.5 py-1 text-sm text-ink-faint">{t('shell.projects.empty')}</p>
        )}
      </nav>

      <div className="shrink-0 border-t border-line p-2 pb-safe">
        <SidebarRow to="/settings" onClick={onNavigate}>
          <Settings size={16} className="shrink-0" />
          <span className="truncate">{user?.displayName ?? t('shell.settings.fallback')}</span>
        </SidebarRow>
        <button
          type="button"
          onClick={() => logout.mutate()}
          className={cx(
            'flex h-10 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm',
            'text-ink-faint transition-colors hover:bg-surface-high hover:text-ink',
          )}
        >
          <LogOut size={16} className="shrink-0" />
          {t('shell.logout')}
        </button>
      </div>
    </div>
  )
}

interface ProjectGroupProps {
  project: ProjectDto
  /** Actives et rangées mêlées : le groupe fait lui-même la coupure. */
  conversations: ConversationDto[]
  open: boolean
  /** Replié par l'utilisateur, indépendamment de la fermeture forcée par un glissement. */
  collapsed: boolean
  onToggle: () => void
  onNavigate: () => void
}

function ProjectGroup({
  project,
  conversations,
  open,
  collapsed,
  onToggle,
  onNavigate,
}: ProjectGroupProps) {
  const t = useTranslate()
  const navigate = useNavigate()
  const updateProject = useUpdateProject()
  const reorder = useReorderConversations(project.id)
  const active = useMemo(() => conversations.filter((c) => !c.archivedAt), [conversations])
  const archived = useMemo(() => conversations.filter((c) => c.archivedAt), [conversations])
  const [archiveOpen, setArchiveOpen] = useState(false)
  // Actif sur les deux écrans « niveau projet » : la nouvelle conversation, qui est
  // désormais la destination du clic, et les réglages atteints par le menu.
  const isSettings = useMatch(`/p/${project.id}`) !== null
  const isDraft = useMatch(`/p/${project.id}/c/new`) !== null
  const isActive = isSettings || isDraft
  // Replié, le projet répond pour ses lignes : sans ce report, un agent qui finit son
  // tour dans un projet fermé ne se signalerait nulle part. Le fil ouvert en est exclu
  // comme il l'est de sa propre ligne, sinon replier le projet qu'on lit l'allumerait
  // à chaque fin de tour, le temps que le curseur reparte.
  const openConversationId = useMatch('/p/:projectId/c/:conversationId')?.params.conversationId
  const hasUnread = useHasUnread(active, openConversationId)

  const [editing, setEditing] = useState(false)

  const sensors = useDragSensors()

  /**
   * Le projet est déplaçable, mais seul son en-tête sert de poignée.
   *
   * Les listeners posés sur l'élément entier engloberaient la liste des conversations,
   * qui a son propre contexte de glissement : un appui sur une conversation
   * démarrerait les deux déplacements à la fois.
   */
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: project.id, disabled: editing })

  const commitRename = (draft: string) => {
    setEditing(false)
    const name = draft.trim()
    if (name && name !== project.name) updateProject.mutate({ id: project.id, name })
  }

  const onDragEnd = (event: DragEndEvent) => {
    // Un glissement se termine par un `mouseup` sur le lien, donc le navigateur émet
    // un clic juste après : sans l'avaler, réordonner ouvrirait la conversation.
    swallowNextClick()

    const { active: dragged, over } = event
    if (!over || dragged.id === over.id) return

    const ids = active.map((entry) => entry.id)
    const from = ids.indexOf(String(dragged.id))
    const to = ids.indexOf(String(over.id))
    if (from === -1 || to === -1) return

    reorder.mutate(arrayMove(ids, from, to))
  }

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cx(isDragging && 'shadow-float z-10 rounded-md bg-surface-high opacity-90')}
    >
      {/* Le fond est porté par la ligne entière, pas par le lien : sinon les boutons
          d'action se retrouvent visuellement hors de l'élément survolé. */}
      <div
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        // Le projet porte le nom en gras et à pleine encre, la conversation en plus
        // petit et en encre atténuée : sans cet écart, les deux niveaux de la
        // navigation se lisaient comme une seule liste plate.
        className={cx(
          'group flex h-9 items-center gap-0.5 rounded-md pr-1 text-ink transition-colors',
          isActive ? 'bg-accent-wash' : 'hover:bg-surface-high',
        )}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-label={
            open
              ? t('shell.project.collapse', { name: project.name })
              : t('shell.project.expand', { name: project.name })
          }
          aria-expanded={open}
          className="flex size-6 shrink-0 items-center justify-center rounded text-ink-faint hover:text-ink"
        >
          <ChevronRight size={13} className={cx('transition-transform', open && 'rotate-90')} />
        </button>

        {editing ? (
          <RenameInput
            value={project.name}
            onCommit={commitRename}
            onCancel={() => setEditing(false)}
            className="h-7 min-w-0 flex-1 rounded border border-accent bg-sunken px-1.5 text-sm text-ink outline-none"
          />
        ) : (
          <NavLink
            to={`/p/${project.id}/c/new`}
            onClick={onNavigate}
            // Renommer au double-clic, comme dans un explorateur de fichiers. Le premier
            // clic navigue quand même : c'est le prix d'un lien, et ouvrir le projet
            // qu'on renomme n'a rien de gênant.
            onDoubleClick={(event) => {
              event.preventDefault()
              if (project.isOwner) setEditing(true)
            }}
            className="flex h-full min-w-0 flex-1 items-center gap-2 px-1.5 text-sm font-semibold"
          >
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full"
              style={{ background: project.color ?? 'var(--sg-accent)' }}
            />
            <span className="truncate">{project.name}</span>
            {/* Uniquement replié : déplié, ce sont les lignes elles-mêmes qui le disent,
                et le point ferait doublon avec ce qu'on a déjà sous les yeux. */}
            {collapsed && hasUnread ? (
              <span
                title={t('shell.project.unread')}
                className="size-1.5 shrink-0 rounded-full bg-ink"
              />
            ) : null}
            {/* Seul le partage est signalé : le privé est le cas normal, et le marquer
                mettrait un cadenas sur presque toutes les lignes. */}
            {project.visibility === 'shared' ? (
              <Users
                size={12}
                className="shrink-0 text-ink-faint"
                aria-label={t('shell.project.shared')}
              />
            ) : null}
          </NavLink>
        )}

        {project.isOwner ? (
          <Menu
            trigger={
              <IconButton
                label={t('shell.project.actions', { name: project.name })}
                size="sm"
                className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
              >
                <MoreHorizontal size={15} />
              </IconButton>
            }
          >
            <MenuItem icon={<Pencil size={14} />} onSelect={() => setEditing(true)}>
              {t('shell.rename')}
            </MenuItem>
            <MenuItem
              icon={<SlidersHorizontal size={14} />}
              onSelect={() => {
                onNavigate()
                navigate(`/p/${project.id}`)
              }}
            >
              {t('shell.project.settings')}
            </MenuItem>
            <MenuSeparator />
            <MenuLabel>
              <span className="flex items-center gap-1.5">
                <Palette size={11} /> {t('shell.color')}
              </span>
            </MenuLabel>
            <MenuSwatchRow>
              {PROJECT_COLORS.map((entry) => (
                <MenuSwatch
                  key={entry.value ?? 'default'}
                  color={entry.value}
                  label={t(entry.label)}
                  selected={project.color === entry.value}
                  onSelect={() => updateProject.mutate({ id: project.id, color: entry.value })}
                />
              ))}
            </MenuSwatchRow>
          </Menu>
        ) : null}
      </div>

      {open ? (
        <ul className="mt-px mb-1 ml-3 flex flex-col gap-px border-l border-line pl-1.5">
          {active.length > 0 ? (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              modifiers={[restrictToVerticalAxis, restrictToParentElement]}
              onDragEnd={onDragEnd}
              // Annuler par Échap relâche aussi la souris sur le lien : même
              // traitement, sinon l'annulation ouvre la conversation.
              onDragCancel={swallowNextClick}
            >
              <SortableContext
                items={active.map((entry) => entry.id)}
                strategy={verticalListSortingStrategy}
              >
                {active.map((conversation) => (
                  <ConversationRow
                    key={conversation.id}
                    conversation={conversation}
                    onNavigate={onNavigate}
                  />
                ))}
              </SortableContext>
            </DndContext>
          ) : (
            <li className="px-2 py-1.5 text-xs text-ink-faint">{t('shell.conversations.empty')}</li>
          )}

          {/* Repliée et en fin de liste : ce qui est rangé doit rester atteignable sans
              revenir peser sur ce qu'on a sous les yeux. Hors des contextes de
              glissement au-dessus, les archivées n'ayant pas d'ordre à défendre. */}
          {archived.length > 0 ? (
            <li>
              <button
                type="button"
                onClick={() => setArchiveOpen((current) => !current)}
                aria-expanded={archiveOpen}
                className="flex h-7 w-full items-center gap-1 rounded px-1 text-xs text-ink-faint transition-colors hover:bg-surface-high hover:text-ink-soft"
              >
                <ChevronRight
                  size={11}
                  className={cx('shrink-0 transition-transform', archiveOpen && 'rotate-90')}
                />
                {t('shell.conversations.archived', { count: String(archived.length) })}
              </button>
              {archiveOpen ? (
                <ul className="flex flex-col gap-px">
                  {archived.map((conversation) => (
                    <ConversationRow
                      key={conversation.id}
                      conversation={conversation}
                      onNavigate={onNavigate}
                    />
                  ))}
                </ul>
              ) : null}
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  )
}

function ConversationRow({
  conversation,
  onNavigate,
}: {
  conversation: ConversationDto
  onNavigate: () => void
}) {
  const t = useTranslate()
  const rename = useRenameConversation()
  const remove = useDeleteConversation()
  const setArchived = useArchiveConversation()
  const isArchived = conversation.archivedAt !== null
  const navigate = useNavigate()
  const openMatch = useMatch('/p/:projectId/c/:conversationId')
  const [editing, setEditing] = useState(false)
  // Le statut du socket prime sur celui de la liste, qui date de son chargement.
  const status = useLiveStatus(conversation.id) ?? conversation.status
  const background = useLiveBackground(conversation.id)
  const loops = useLiveLoops(conversation.id)
  const pushedSeq = useLiveSeq(conversation.id)
  const detailed = useSidebarDetailed()
  // Même arbitrage que le statut : ce que le socket a poussé prime sur la liste, qui
  // date de son chargement. Rien n'a encore été poussé pour un fil froid, et les
  // chiffres de la liste sont alors les bons.
  const metrics = useLiveMetrics(conversation.id) ?? conversation.metrics
  const signals = useMemo(
    () => buildSidebarSignals({ status, background, loops }),
    [status, background, loops],
  )
  const present = presentSignal(signals)
  const loop = signals.find((signal) => signal.kind === 'loop') ?? null

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: conversation.id,
    // Renommer place un champ de saisie dans la ligne : la rendre déplaçable
    // pendant ce temps rendrait la sélection de texte impossible. Rangée, la ligne
    // vit hors de tout contexte de glissement et n'a rien à y inscrire.
    disabled: editing || isArchived,
  })

  const commit = (draft: string) => {
    setEditing(false)
    const value = draft.trim()
    if (value && value !== conversation.title) {
      rename.mutate({ id: conversation.id, title: value })
    }
  }

  const style = { transform: CSS.Transform.toString(transform), transition }

  if (editing) {
    return (
      <li ref={setNodeRef} style={style}>
        <RenameInput
          value={conversation.title}
          onCommit={commit}
          onCancel={() => setEditing(false)}
          className="h-9 w-full rounded-md border border-accent bg-sunken px-2 text-sm text-ink outline-none"
        />
      </li>
    )
  }

  const isActive = openMatch?.params.conversationId === conversation.id
  /*
    Le non-lu se dit par l'encre et la graisse, pas par un troisième point : la ligne en
    tient deux au plus, et une pastille de plus ferait concurrence à des signaux qui,
    eux, parlent de l'instant. Un fil qui a du nouveau remonte simplement de l'encre
    atténuée à l'encre pleine.

    Le fil ouvert en est exclu sans attendre le serveur : on est dedans, et le curseur
    ne part qu'à la seconde suivante.
  */
  const unread = !isActive && isUnread(conversation, pushedSeq)

  return (
    <li
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={cx(
        'group/row flex rounded-md pr-1 transition-colors',
        // Le détail fait grandir la ligne vers le bas : le menu et les signaux restent
        // sur le titre, à la hauteur qu'ils avaient sans lui.
        detailed ? 'min-h-9 items-start' : 'h-9 items-center',
        isDragging ? 'shadow-float z-10 bg-surface-high opacity-90' : '',
        isActive ? 'bg-accent-wash' : 'hover:bg-surface-high hover:text-ink',
        isActive || unread ? 'text-ink' : 'text-ink-faint',
      )}
    >
      <NavLink
        to={`/p/${conversation.projectId}/c/${conversation.id}`}
        onClick={onNavigate}
        onDoubleClick={(event) => {
          event.preventDefault()
          if (conversation.isOwner) setEditing(true)
        }}
        className={cx(
          'flex min-w-0 flex-1 flex-col justify-center px-2 text-[0.8125rem]',
          detailed ? 'py-1.5' : 'h-full',
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-ink-faint">
            <AgentIcon agent={conversation.agent} size={13} />
          </span>
          <span className={cx('truncate', unread && 'font-medium')}>{conversation.title}</span>
          {/*
            Deux points au plus, et jamais davantage : l'état présent, et la boucle.
            Le premier est le plus grave de ce qui se passe maintenant ; la seconde parle
            de ce qui arrivera, donc elle ne lui fait pas concurrence et s'affiche à côté,
            y compris pendant un tour.

            La pastille d'origine les précède sans leur faire concurrence : elle ne dit pas
            un état mais une provenance, elle ne change jamais, et elle s'efface au survol
            pour rendre la place aux actions de la ligne.
          */}
          <span className="ml-auto flex shrink-0 items-center gap-1">
            {conversation.origin ? (
              <span
                title={t('shell.conversation.origin', { label: conversation.origin.label })}
                className="rounded-full bg-accent-wash px-1 py-px text-[0.5625rem] font-semibold uppercase tracking-wide text-accent"
              >
                {t('shell.conversation.api')}
              </span>
            ) : null}
            {present ? <SignalDot signal={present} /> : null}
            {loop ? <SignalDot signal={loop} /> : null}
          </span>
        </span>
        {detailed ? <ConversationMetricsLine metrics={metrics} /> : null}
      </NavLink>

      {conversation.isOwner ? (
        <Menu
          trigger={
            <IconButton
              label={t('shell.conversation.actions')}
              size="sm"
              className="opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100 data-[state=open]:opacity-100"
            >
              <MoreHorizontal size={15} />
            </IconButton>
          }
        >
          <MenuItem icon={<Pencil size={14} />} onSelect={() => setEditing(true)}>
            {t('shell.rename')}
          </MenuItem>
          <MenuItem
            icon={isArchived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
            onSelect={() => setArchived.mutate({ id: conversation.id, archived: !isArchived })}
          >
            {isArchived ? t('shell.conversation.unarchive') : t('shell.conversation.archive')}
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon={<Trash2 size={14} />}
            tone="critical"
            onSelect={() => {
              if (!confirm(t('shell.conversation.deleteConfirm', { title: conversation.title })))
                return
              const wasOpen = openMatch?.params.conversationId === conversation.id
              remove.mutate(conversation.id, {
                // Ne quitter la vue que si c'est bien celle qu'on vient de supprimer.
                onSuccess: () => {
                  if (wasOpen) navigate(`/p/${conversation.projectId}/c/new`)
                },
              })
            }}
          >
            {t('shell.delete')}
          </MenuItem>
        </Menu>
      ) : null}
    </li>
  )
}

/**
 * Le relevé de volume, sous le titre.
 *
 * Ni bordure ni fond : c'est un prolongement de la ligne, pas un panneau posé dedans.
 * Les chiffres restent sur une seule ligne et disparaissent par la droite plutôt que de
 * passer à la suivante, l'ordre allant du plus parlant au plus accessoire.
 */
function ConversationMetricsLine({ metrics }: { metrics: ConversationMetrics }) {
  const t = useTranslate()
  const { context } = metrics

  return (
    <span className="mt-0.5 flex min-w-0 items-center gap-2 overflow-hidden pl-[21px] text-[0.6875rem] whitespace-nowrap text-ink-faint tabular-nums">
      <span title={t('shell.conversation.turnsTitle')}>
        {t('shell.conversation.turns', { count: metrics.turnCount })}
      </span>
      <span title={t('shell.conversation.sizeTitle')}>{formatBytes(metrics.journalBytes)}</span>
      {context && context.maxTokens > 0 ? (
        <span
          title={t('shell.conversation.contextTitle', {
            used: formatTokens(context.usedTokens),
            max: formatTokens(context.maxTokens),
          })}
        >
          {Math.round((context.usedTokens / context.maxTokens) * 100)} %
        </span>
      ) : null}
      {metrics.model ? (
        <span className="truncate" title={t('shell.conversation.modelTitle')}>
          {metrics.model}
        </span>
      ) : null}
    </span>
  )
}

function SidebarRow({
  to,
  onClick,
  children,
}: {
  to: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <NavLink
      to={to}
      end
      onClick={onClick}
      className={({ isActive }) =>
        cx(
          'flex h-10 items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors',
          isActive
            ? 'bg-accent-wash font-medium text-ink'
            : 'text-ink-soft hover:bg-surface-high hover:text-ink',
        )
      }
    >
      {children}
    </NavLink>
  )
}
