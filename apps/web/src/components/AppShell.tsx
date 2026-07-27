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
  ChevronRight,
  FolderPlus,
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
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { NavLink, useMatch, useNavigate } from 'react-router-dom'
import { Outlet } from 'react-router-dom'
import type { ConversationDto, ProjectDto } from '@sillage/protocol'
import {
  useAllConversations,
  useDeleteConversation,
  useRenameConversation,
  useReorderConversations,
} from '../lib/conversations'
import { useProjects, useReorderProjects, useUpdateProject } from '../lib/projects'
import {
  restoreSidebarWidth,
  setSidebarHidden,
  setSidebarWidth,
  useSidebarHidden,
} from '../lib/sidebar'
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
  const [navOpen, setNavOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const hidden = useSidebarHidden()
  const aside = useRef<HTMLElement>(null)
  useVisualViewport()

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
     * Calque fixe aux dimensions du viewport **visuel**, pas du viewport de mise en
     * page.
     *
     * À l'ouverture du clavier, `100dvh` continue de valoir la hauteur de l'écran
     * entier et la barre de saisie se retrouve dessous. Ici, l'application entière est
     * redimensionnée et remontée de `--sg-viewport-top` : le clavier pousse tout vers
     * le haut, au lieu de recouvrir le bas.
     */
    <div
      className={cx(
        'fixed inset-x-0 top-[var(--sg-viewport-top,0px)] flex overflow-hidden',
        'h-[var(--sg-app-height,100dvh)] gradient-canvas text-ink',
      )}
    >
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
            aria-label="Largeur de la navigation"
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
          <IconButton label="Afficher la navigation" onClick={() => setSidebarHidden(false)}>
            <PanelLeft size={18} />
          </IconButton>
        </div>
      ) : null}

      <CommandPalette open={searchOpen} onOpenChange={setSearchOpen} />
      <UpdatePrompt />

      {navOpen ? (
        <button
          type="button"
          aria-label="Fermer la navigation"
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
          <IconButton label="Ouvrir la navigation" onClick={() => setNavOpen(true)}>
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
  const { data: user } = useCurrentUser()
  const { data: projects } = useProjects()
  const { data: conversations } = useAllConversations()
  const logout = useLogout()
  const reorder = useReorderProjects()
  const sensors = useDragSensors()

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
          <IconButton label="Fermer la navigation" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </span>
        <span className="ml-auto hidden md:block">
          <IconButton label="Masquer la navigation" onClick={onCollapse}>
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
          <span className="flex-1">Rechercher</span>
          <kbd className="hidden shrink-0 rounded border border-line px-1 text-[0.625rem] text-ink-faint md:block">
            {SEARCH_HINT}
          </kbd>
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
        <div className="flex items-center justify-between py-1 pr-1 pl-2.5">
          <span className="text-[0.6875rem] font-semibold tracking-wider text-ink-faint uppercase">
            Projets
          </span>
          <NavLink to="/settings/projects" onClick={onNavigate} aria-label="Ajouter un projet">
            <IconButton label="Ajouter un projet" size="sm">
              <FolderPlus size={15} />
            </IconButton>
          </NavLink>
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
                    onToggle={() => toggle(project.id)}
                    onNavigate={onNavigate}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        ) : (
          <p className="px-2.5 py-1 text-sm text-ink-faint">Aucun projet</p>
        )}
      </nav>

      <div className="shrink-0 border-t border-line p-2 pb-safe">
        <SidebarRow to="/settings" onClick={onNavigate}>
          <Settings size={16} className="shrink-0" />
          <span className="truncate">{user?.displayName ?? 'Réglages'}</span>
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
          Se déconnecter
        </button>
      </div>
    </div>
  )
}

interface ProjectGroupProps {
  project: ProjectDto
  conversations: ConversationDto[]
  open: boolean
  onToggle: () => void
  onNavigate: () => void
}

function ProjectGroup({
  project,
  conversations,
  open,
  onToggle,
  onNavigate,
}: ProjectGroupProps) {
  const navigate = useNavigate()
  const updateProject = useUpdateProject()
  const reorder = useReorderConversations(project.id)
  // Actif sur les deux écrans « niveau projet » : la nouvelle conversation, qui est
  // désormais la destination du clic, et les réglages atteints par le menu.
  const isSettings = useMatch(`/p/${project.id}`) !== null
  const isDraft = useMatch(`/p/${project.id}/c/new`) !== null
  const isActive = isSettings || isDraft

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

    const { active, over } = event
    if (!over || active.id === over.id) return

    const ids = conversations.map((entry) => entry.id)
    const from = ids.indexOf(String(active.id))
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
          aria-label={open ? `Replier ${project.name}` : `Déplier ${project.name}`}
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
            {/* Seul le partage est signalé : le privé est le cas normal, et le marquer
                mettrait un cadenas sur presque toutes les lignes. */}
            {project.visibility === 'shared' ? (
              <Users
                size={12}
                className="shrink-0 text-ink-faint"
                aria-label="Projet partagé"
              />
            ) : null}
          </NavLink>
        )}

        {project.isOwner ? (
          <Menu
            trigger={
              <IconButton
                label={`Actions du projet ${project.name}`}
                size="sm"
                className="opacity-0 focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
              >
                <MoreHorizontal size={15} />
              </IconButton>
            }
          >
            <MenuItem icon={<Pencil size={14} />} onSelect={() => setEditing(true)}>
              Renommer
            </MenuItem>
            <MenuItem
              icon={<SlidersHorizontal size={14} />}
              onSelect={() => {
                onNavigate()
                navigate(`/p/${project.id}`)
              }}
            >
              Réglages du projet
            </MenuItem>
            <MenuSeparator />
            <MenuLabel>
              <span className="flex items-center gap-1.5">
                <Palette size={11} /> Couleur
              </span>
            </MenuLabel>
            <MenuSwatchRow>
              {PROJECT_COLORS.map((entry) => (
                <MenuSwatch
                  key={entry.value ?? 'default'}
                  color={entry.value}
                  label={entry.label}
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
          {conversations.length > 0 ? (
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
                items={conversations.map((entry) => entry.id)}
                strategy={verticalListSortingStrategy}
              >
                {conversations.map((conversation) => (
                  <ConversationRow
                    key={conversation.id}
                    conversation={conversation}
                    onNavigate={onNavigate}
                  />
                ))}
              </SortableContext>
            </DndContext>
          ) : (
            <li className="px-2 py-1.5 text-xs text-ink-faint">Aucune conversation</li>
          )}
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
  const rename = useRenameConversation()
  const remove = useDeleteConversation()
  const navigate = useNavigate()
  const openMatch = useMatch('/p/:projectId/c/:conversationId')
  const [editing, setEditing] = useState(false)

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: conversation.id,
    // Renommer place un champ de saisie dans la ligne : la rendre déplaçable
    // pendant ce temps rendrait la sélection de texte impossible.
    disabled: editing,
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
  const busy = conversation.status === 'running' || conversation.status === 'awaiting_input'

  return (
    <li
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={cx(
        'group/row flex h-9 items-center rounded-md pr-1 transition-colors',
        isDragging ? 'shadow-float z-10 bg-surface-high opacity-90' : '',
        isActive ? 'bg-accent-wash text-ink' : 'text-ink-faint hover:bg-surface-high hover:text-ink',
      )}
    >
      <NavLink
        to={`/p/${conversation.projectId}/c/${conversation.id}`}
        onClick={onNavigate}
        onDoubleClick={(event) => {
          event.preventDefault()
          if (conversation.isOwner) setEditing(true)
        }}
        className="flex h-full min-w-0 flex-1 items-center gap-2 px-2 text-[0.8125rem]"
      >
        <span className="shrink-0 text-ink-faint">
          <AgentIcon agent={conversation.agent} size={13} />
        </span>
        <span className="truncate">{conversation.title}</span>
        {busy ? (
          <span
            aria-label="En cours"
            className={cx(
              'ml-auto size-1.5 shrink-0 rounded-full',
              conversation.status === 'awaiting_input' ? 'bg-caution' : 'bg-accent animate-pulse',
            )}
          />
        ) : null}
      </NavLink>

      {conversation.isOwner ? (
        <Menu
          trigger={
            <IconButton
              label="Actions de la conversation"
              size="sm"
              className="opacity-0 focus-visible:opacity-100 group-hover/row:opacity-100 data-[state=open]:opacity-100"
            >
              <MoreHorizontal size={15} />
            </IconButton>
          }
        >
          <MenuItem icon={<Pencil size={14} />} onSelect={() => setEditing(true)}>
            Renommer
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            icon={<Trash2 size={14} />}
            tone="critical"
            onSelect={() => {
              if (!confirm(`Supprimer "${conversation.title}" ?`)) return
              const wasOpen = openMatch?.params.conversationId === conversation.id
              remove.mutate(conversation.id, {
                // Ne quitter la vue que si c'est bien celle qu'on vient de supprimer.
                onSuccess: () => {
                  if (wasOpen) navigate(`/p/${conversation.projectId}/c/new`)
                },
              })
            }}
          >
            Supprimer
          </MenuItem>
        </Menu>
      ) : null}
    </li>
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
