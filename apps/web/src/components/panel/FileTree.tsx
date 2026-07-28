import {
  AtSign,
  ChevronRight,
  FilePlus2,
  FileSymlink,
  FolderPlus,
  Loader,
  MoreHorizontal,
  Pencil,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import { Fragment, useState, type DragEvent, type ReactNode } from 'react'
import type { FileState, TreeEntryDto } from '@sillage/protocol'
import { referenceInComposer } from '../../lib/composer-ref'
import { openTab } from '../../lib/editor-tabs'
import {
  parentOf,
  siblingPath,
  useCreateEntry,
  useDeleteEntry,
  useMoveEntry,
} from '../../lib/entries'
import { fileIconUrl } from '../../lib/file-icons'
import { translate, useTranslate } from '../../lib/i18n'
import { useFileSearch, useTreeLevel } from '../../lib/tree'
import {
  ConfirmDialog,
  ContextMenu,
  ContextMenuItem,
  ContextMenuSeparator,
  Menu,
  MenuItem,
  MenuSeparator,
  cx,
} from '../ui'

/**
 * Couleur et lettre par état git, dans le vocabulaire de `git status`.
 *
 * Les deux ensemble et non la couleur seule : distinguer cinq teintes proches est
 * difficile, et impossible pour qui perçoit mal les couleurs.
 */
const STATES: Record<FileState, { letter: string; tone: string }> = {
  modified: { letter: 'M', tone: 'text-caution' },
  added: { letter: 'A', tone: 'text-positive' },
  deleted: { letter: 'D', tone: 'text-critical' },
  untracked: { letter: '?', tone: 'text-positive' },
  ignored: { letter: '', tone: 'text-ink-faint/60' },
}

/** Décalage par niveau. Plus serré que la sidebar : l'arborescence descend plus bas. */
const INDENT_PX = 12

/** Type de transfert du glisser-déposer : il porte le chemin de l'entrée déplacée. */
const DRAG_TYPE = 'application/x-sillage-path'

/** Saisie en cours dans l'arborescence : création d'une entrée, ou renommage. */
type Draft =
  | { mode: 'create'; parent: string; kind: 'file' | 'directory' }
  | { mode: 'rename'; path: string; name: string }

export function FileTree({
  conversationId,
  onOpenFile,
}: {
  conversationId: string
  /** Bascule sur l'éditeur : ouvrir un fichier sans le montrer ne servirait à rien. */
  onOpenFile: () => void
}) {
  const t = useTranslate()
  const [draft, setDraft] = useState<Draft | null>(null)
  const [query, setQuery] = useState('')
  /** Entrée dont la suppression est proposée : le geste est sans retour possible. */
  const [pendingDelete, setPendingDelete] = useState<TreeEntryDto | null>(null)
  const create = useCreateEntry(conversationId)
  const move = useMoveEntry(conversationId)
  const remove = useDeleteEntry(conversationId)

  const error = create.error ?? move.error ?? remove.error

  const actions: Actions = {
    conversationId,
    draft,
    setDraft,
    onOpenFile,
    onCreate: (parent, name, kind) => {
      setDraft(null)
      create.mutate({ parent, name, kind })
    },
    onRename: (path, name) => {
      setDraft(null)
      if (name !== path.split('/').pop()) move.mutate({ from: path, to: siblingPath(path, name) })
    },
    onMove: (from, toParent) => {
      const name = from.split('/').pop() ?? from
      const to = toParent ? `${toParent}/${name}` : name
      if (to !== from) move.mutate({ from, to })
    },
    onDelete: setPendingDelete,
  }

  const searching = query.trim().length >= 2

  return (
    <div>
      <div className="flex items-center gap-1 px-2 pb-1.5">
        <div className="relative min-w-0 flex-1">
          <Search
            size={13}
            className="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-ink-faint"
          />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setQuery('')
            }}
            placeholder={t('filetree.search.placeholder')}
            aria-label={t('filetree.search.label')}
            className={cx(
              'h-7 w-full rounded-md border border-line bg-sunken pr-6 pl-7',
              'text-[0.8125rem] text-ink placeholder:text-ink-faint',
              'outline-none focus:border-accent',
            )}
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label={t('filetree.search.clear')}
              className="absolute top-1/2 right-1 -translate-y-1/2 rounded p-0.5 text-ink-faint hover:text-ink"
            >
              <X size={12} />
            </button>
          ) : null}
        </div>

        {/* Le dossier racine n'a pas de ligne à survoler : ses actions vivent ici. */}
        <RootAction
          label={t('filetree.root.newFile')}
          icon={<FilePlus2 size={13} />}
          onClick={() => setDraft({ mode: 'create', parent: '', kind: 'file' })}
        />
        <RootAction
          label={t('filetree.root.newFolder')}
          icon={<FolderPlus size={13} />}
          onClick={() => setDraft({ mode: 'create', parent: '', kind: 'directory' })}
        />
      </div>

      {error ? (
        <p className="mx-2 mb-1 rounded border border-critical/40 bg-critical/12 px-2 py-1 text-xs text-critical">
          {error instanceof Error ? error.message : t('filetree.error.generic')}
        </p>
      ) : null}

      {/* La recherche remplace l'arborescence au lieu de la filtrer sur place : replier
          et déplier des dossiers pour suivre un résultat ferait perdre le fil, et les
          niveaux dépliés doivent être retrouvés intacts en effaçant la recherche. */}
      {searching ? (
        <SearchResults conversationId={conversationId} query={query} actions={actions} />
      ) : (
        <Level path="" depth={0} expanded actions={actions} />
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(null)
        }}
        title={
          pendingDelete?.isDirectory
            ? t('filetree.delete.confirmFolder')
            : t('filetree.delete.confirmFile')
        }
        confirmLabel={t('filetree.delete.confirm')}
        tone="critical"
        onConfirm={() => {
          if (pendingDelete) remove.mutate({ path: pendingDelete.path })
          setPendingDelete(null)
        }}
      >
        <p className="font-mono text-xs break-all text-ink">{pendingDelete?.path}</p>
        <p>
          {pendingDelete?.isDirectory
            ? t('filetree.delete.bodyFolder')
            : t('filetree.delete.bodyFile')}{' '}
          {t('filetree.delete.note')}
        </p>
      </ConfirmDialog>
    </div>
  )
}

/** Résultats plats : un chemin complet dit mieux d'où vient un fichier qu'une indentation. */
function SearchResults({
  conversationId,
  query,
  actions,
}: {
  conversationId: string
  query: string
  actions: Actions
}) {
  const t = useTranslate()
  const { data, isPending, error } = useFileSearch(conversationId, query)

  if (error) {
    return (
      <p className="px-2 py-1.5 text-xs text-critical">
        {error instanceof Error ? error.message : t('filetree.search.error')}
      </p>
    )
  }

  if (isPending) {
    return (
      <p className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-ink-faint">
        <Loader size={11} className="animate-spin" />
        {t('filetree.search.loading')}
      </p>
    )
  }

  if (data.entries.length === 0) {
    return <p className="px-2 py-1.5 text-xs text-ink-faint">{t('filetree.search.empty')}</p>
  }

  return (
    <ul>
      {data.entries.map((entry) => (
        <li key={entry.path}>
          <EntryRow entry={entry} actions={actions}>
            <span className="flex min-w-0 flex-1 flex-col text-left leading-tight">
              <span className="truncate text-[0.8125rem] text-ink-soft">{entry.name}</span>
              <span className="truncate text-[0.6875rem] text-ink-faint">{entry.path}</span>
            </span>
          </EntryRow>
        </li>
      ))}

      {data.truncated ? (
        <li className="px-2 py-1.5 text-[0.6875rem] text-ink-faint">
          {t('filetree.search.truncated')}
        </li>
      ) : null}
    </ul>
  )
}

function RootAction({
  label,
  icon,
  onClick,
}: {
  label: string
  icon: React.ReactNode
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className="flex size-6 items-center justify-center rounded text-ink-faint transition-colors hover:bg-surface-high hover:text-ink"
    >
      {icon}
    </button>
  )
}

/**
 * Ce que les lignes peuvent déclencher.
 *
 * Passé en bloc plutôt qu'une prop par action : l'arborescence est récursive, et
 * sept props traverseraient chaque niveau sans que celui-ci les regarde.
 */
interface Actions {
  conversationId: string
  draft: Draft | null
  setDraft: (draft: Draft | null) => void
  onOpenFile: () => void
  onCreate: (parent: string, name: string, kind: 'file' | 'directory') => void
  onRename: (path: string, name: string) => void
  onMove: (from: string, toParent: string) => void
  onDelete: (entry: TreeEntryDto) => void
}

function Level({
  path,
  depth,
  expanded,
  actions,
}: {
  path: string
  depth: number
  expanded: boolean
  actions: Actions
}) {
  const t = useTranslate()
  const { data, isPending, error } = useTreeLevel(actions.conversationId, path, expanded)
  const draft = actions.draft
  const creatingHere = draft?.mode === 'create' && draft.parent === path

  if (!expanded) return null

  if (error) {
    return (
      <p className="px-2 py-1 text-xs text-critical" style={{ paddingLeft: depth * INDENT_PX + 8 }}>
        {error instanceof Error ? error.message : t('filetree.error.unreadable')}
      </p>
    )
  }

  if (isPending || !data) {
    return (
      <p
        className="flex items-center gap-1.5 px-2 py-1 text-xs text-ink-faint"
        style={{ paddingLeft: depth * INDENT_PX + 8 }}
      >
        <Loader size={11} className="animate-spin" />
        {t('filetree.loading')}
      </p>
    )
  }

  return (
    <ul>
      {creatingHere ? (
        <li>
          <NameInput
            depth={depth}
            icon={fileIconUrl(draft.kind === 'directory' ? 'folder' : 'file', draft.kind === 'directory')}
            initial=""
            onCommit={(name) => actions.onCreate(path, name, draft.kind)}
            onCancel={() => actions.setDraft(null)}
          />
        </li>
      ) : null}

      {data.entries.length === 0 && !creatingHere ? (
        <li
          className="px-2 py-1 text-xs text-ink-faint"
          style={{ paddingLeft: depth * INDENT_PX + 8 }}
        >
          {t('filetree.empty')}
        </li>
      ) : null}

      {data.entries.map((entry) => (
        <Entry key={entry.path} entry={entry} depth={depth} actions={actions} />
      ))}
    </ul>
  )
}

/** Une action proposée sur une entrée, rendue dans les deux menus. */
interface EntryAction {
  key: string
  icon: ReactNode
  label: string
  tone?: 'critical'
  run: () => void
}

/**
 * Les actions d'une entrée, en données plutôt qu'en éléments.
 *
 * Elles s'affichent à deux endroits, au clic droit et derrière les trois points, et
 * les deux menus viennent de modules Radix distincts dont les éléments ne se
 * partagent pas. Décrire les actions une fois et les rendre deux fois évite que les
 * deux listes divergent.
 */
function entryActions(entry: TreeEntryDto, actions: Actions, expand: () => void): EntryAction[] {
  const open = () => {
    openTab(actions.conversationId, entry.path)
    actions.onOpenFile()
  }

  return [
    ...(entry.isDirectory
      ? [
          {
            key: 'new-file',
            icon: <FilePlus2 size={14} />,
            label: translate('filetree.entry.newFile'),
            run: () => {
              expand()
              actions.setDraft({ mode: 'create', parent: entry.path, kind: 'file' })
            },
          },
          {
            key: 'new-dir',
            icon: <FolderPlus size={14} />,
            label: translate('filetree.entry.newFolder'),
            run: () => {
              expand()
              actions.setDraft({ mode: 'create', parent: entry.path, kind: 'directory' })
            },
          },
        ]
      : [
          {
            key: 'open',
            icon: <FileSymlink size={14} />,
            label: translate('filetree.entry.open'),
            run: open,
          },
          {
            key: 'reference',
            icon: <AtSign size={14} />,
            label: translate('filetree.entry.reference'),
            run: () => referenceInComposer(entry.path),
          },
        ]),
    {
      key: 'rename',
      icon: <Pencil size={14} />,
      label: translate('filetree.entry.rename'),
      run: () => actions.setDraft({ mode: 'rename', path: entry.path, name: entry.name }),
    },
    {
      key: 'delete',
      icon: <Trash2 size={14} />,
      label: translate('filetree.entry.delete'),
      tone: 'critical' as const,
      run: () => actions.onDelete(entry),
    },
  ]
}

/** La séparation isole les créations du reste : elles n'agissent pas sur l'entrée visée. */
function separatorAfter(entry: TreeEntryDto): string {
  return entry.isDirectory ? 'new-dir' : 'reference'
}

/**
 * Ligne d'un résultat de recherche.
 *
 * Plus simple qu'une ligne d'arborescence : ni chevron, ni glisser-déposer, ni
 * décalage, puisqu'il n'y a pas de niveau à représenter.
 */
function EntryRow({
  entry,
  actions,
  children,
}: {
  entry: TreeEntryDto
  actions: Actions
  children: ReactNode
}) {
  return (
    <ContextMenu
      trigger={
        <button
          type="button"
          onDoubleClick={() => {
            openTab(actions.conversationId, entry.path)
            actions.onOpenFile()
          }}
          className={cx(
            'flex w-full min-w-0 items-center gap-1.5 px-2 py-1 text-left',
            'transition-colors hover:bg-surface-high',
          )}
        >
          <img src={fileIconUrl(entry.name, false)} alt="" aria-hidden className="size-4 shrink-0" />
          {children}
        </button>
      }
    >
      <EntryMenuItems entry={entry} actions={actions} expand={() => {}} />
    </ContextMenu>
  )
}

function EntryMenuItems({
  entry,
  actions,
  expand,
}: {
  entry: TreeEntryDto
  actions: Actions
  expand: () => void
}) {
  const separator = separatorAfter(entry)
  return (
    <>
      {entryActions(entry, actions, expand).map((action) => (
        <Fragment key={action.key}>
          <ContextMenuItem icon={action.icon} tone={action.tone} onSelect={action.run}>
            {action.label}
          </ContextMenuItem>
          {action.key === separator ? <ContextMenuSeparator /> : null}
        </Fragment>
      ))}
    </>
  )
}

function Entry({
  entry,
  depth,
  actions,
}: {
  entry: TreeEntryDto
  depth: number
  actions: Actions
}) {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const [dropping, setDropping] = useState(false)
  const state = entry.state ? STATES[entry.state] : null
  const draft = actions.draft

  if (draft?.mode === 'rename' && draft.path === entry.path) {
    return (
      <li>
        <NameInput
          depth={depth}
          icon={fileIconUrl(entry.name, entry.isDirectory)}
          initial={entry.name}
          onCommit={(name) => actions.onRename(entry.path, name)}
          onCancel={() => actions.setDraft(null)}
        />
      </li>
    )
  }

  /** Un dossier accepte le dépôt ; un fichier le renvoie à son dossier parent. */
  const dropTarget = entry.isDirectory ? entry.path : parentOf(entry.path)

  const onDrop = (event: DragEvent) => {
    event.preventDefault()
    event.stopPropagation()
    setDropping(false)

    const from = event.dataTransfer.getData(DRAG_TYPE)
    // Déposer un dossier sur lui-même ou dans sa propre descendance n'a pas de sens :
    // le serveur le refuse, mais autant ne pas envoyer la requête.
    if (!from || from === dropTarget || dropTarget.startsWith(`${from}/`)) return
    actions.onMove(from, dropTarget)
  }

  const expand = () => setOpen(true)

  return (
    <li>
      <ContextMenu
        trigger={
          <div
            className={cx('group/entry flex items-center', dropping && 'bg-accent-wash')}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData(DRAG_TYPE, entry.path)
              event.dataTransfer.effectAllowed = 'move'
            }}
            onDragOver={(event) => {
              // Sans `preventDefault`, le navigateur refuse le dépôt sans rien dire.
              if (!event.dataTransfer.types.includes(DRAG_TYPE)) return
              event.preventDefault()
              event.dataTransfer.dropEffect = 'move'
              setDropping(true)
            }}
            onDragLeave={() => setDropping(false)}
            onDrop={onDrop}
          >
            <button
              type="button"
              /*
               * Un dossier se déplie au clic simple, c'est le geste qu'on attend de lui.
               * Un fichier, non : le clic simple ne fait que le désigner, et c'est le
               * double clic qui l'ouvre. Ouvrir au premier clic remplissait la barre
               * d'onglets en parcourant l'arborescence, et empêchait de viser une ligne
               * pour la renommer ou la déplacer sans en subir l'ouverture.
               */
              onClick={entry.isDirectory ? () => setOpen((value) => !value) : undefined}
              onDoubleClick={
                entry.isDirectory
                  ? undefined
                  : () => {
                      openTab(actions.conversationId, entry.path)
                      actions.onOpenFile()
                    }
              }
              aria-expanded={entry.isDirectory ? open : undefined}
              className={cx(
                'flex h-7 min-w-0 flex-1 items-center gap-1.5 text-left text-[0.8125rem]',
                'transition-colors group-hover/entry:bg-surface-high',
                entry.state === 'ignored' ? 'text-ink-faint/60' : 'text-ink-soft',
              )}
              style={{ paddingLeft: depth * INDENT_PX + 6 }}
            >
              {entry.isDirectory ? (
                <ChevronRight
                  size={12}
                  className={cx('shrink-0 text-ink-faint transition-transform', open && 'rotate-90')}
                />
              ) : (
                <span className="w-3 shrink-0" />
              )}

              {/* `alt` vide : l'icône répète le nom écrit juste à côté. */}
              <img
                src={fileIconUrl(entry.name, entry.isDirectory, open)}
                alt=""
                aria-hidden
                className="size-4 shrink-0"
              />

              <span className={cx('min-w-0 flex-1 truncate', state && state.tone)}>
                {entry.name}
              </span>

              {state?.letter ? (
                <span className={cx('shrink-0 font-mono text-[0.625rem]', state.tone)}>
                  {state.letter}
                </span>
              ) : null}
            </button>

            {/* Le menu reste visible tant qu'il est ouvert : sinon il disparaît sous le
                curseur dès que celui-ci quitte la ligne pour aller le choisir. */}
            <div
              className={cx(
                'shrink-0 pr-1 opacity-0 transition-opacity',
                'group-hover/entry:opacity-100 has-[[data-state=open]]:opacity-100',
                'focus-within:opacity-100 pointer-coarse:opacity-100',
              )}
            >
              <Menu
                trigger={
                  <button
                    type="button"
                    aria-label={t('filetree.entry.actions', { name: entry.name })}
                    className="flex size-6 items-center justify-center rounded text-ink-faint hover:text-ink"
                  >
                    <MoreHorizontal size={14} />
                  </button>
                }
              >
                {entryActions(entry, actions, expand).map((action) => (
                  <Fragment key={action.key}>
                    <MenuItem icon={action.icon} tone={action.tone} onSelect={action.run}>
                      {action.label}
                    </MenuItem>
                    {action.key === separatorAfter(entry) ? <MenuSeparator /> : null}
                  </Fragment>
                ))}
              </Menu>
            </div>
          </div>
        }
      >
        <EntryMenuItems entry={entry} actions={actions} expand={expand} />
      </ContextMenu>

      {entry.isDirectory ? (
        <Level path={entry.path} depth={depth + 1} expanded={open} actions={actions} />
      ) : null}
    </li>
  )
}

/**
 * Champ de saisie d'un nom, pour une création comme pour un renommage.
 *
 * Le nom est présélectionné sans son extension quand il y en a une : renommer part
 * presque toujours du corps du nom, et retaper `.tsx` à chaque fois n'apporte rien.
 */
function NameInput({
  depth,
  icon,
  initial,
  onCommit,
  onCancel,
}: {
  depth: number
  icon: string
  initial: string
  onCommit: (name: string) => void
  onCancel: () => void
}) {
  const t = useTranslate()
  const [value, setValue] = useState(initial)

  return (
    <div
      className="flex h-7 items-center gap-1.5 pr-2"
      style={{ paddingLeft: depth * INDENT_PX + 6 }}
    >
      <span className="w-3 shrink-0" />
      <img src={icon} alt="" aria-hidden className="size-4 shrink-0" />
      <input
        autoFocus
        aria-label={t('filetree.name.label')}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onFocus={(event) => {
          const dot = initial.lastIndexOf('.')
          event.currentTarget.setSelectionRange(0, dot > 0 ? dot : initial.length)
        }}
        onBlur={() => {
          const name = value.trim()
          if (name && name !== initial) onCommit(name)
          else onCancel()
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            const name = value.trim()
            if (name) onCommit(name)
            else onCancel()
          }
          if (event.key === 'Escape') onCancel()
        }}
        className="h-6 min-w-0 flex-1 rounded border border-accent bg-sunken px-1 text-[0.8125rem] text-ink outline-none"
      />
    </div>
  )
}
