import {
  ChevronRight,
  FilePlus2,
  FolderPlus,
  Loader,
  MoreHorizontal,
  Pencil,
  Trash2,
} from 'lucide-react'
import { useState, type DragEvent } from 'react'
import type { FileState, TreeEntryDto } from '@sillage/protocol'
import { openTab } from '../../lib/editor-tabs'
import {
  parentOf,
  siblingPath,
  useCreateEntry,
  useDeleteEntry,
  useMoveEntry,
} from '../../lib/entries'
import { fileIconUrl } from '../../lib/file-icons'
import { useTreeLevel } from '../../lib/tree'
import { Menu, MenuItem, MenuSeparator, cx } from '../ui'

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
  const [draft, setDraft] = useState<Draft | null>(null)
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
    onDelete: (path, isDirectory) => {
      const what = isDirectory ? 'le dossier et tout son contenu' : 'le fichier'
      if (confirm(`Supprimer ${what} « ${path} » ?`)) remove.mutate({ path })
    },
  }

  return (
    <div>
      {error ? (
        <p className="mx-2 mb-1 rounded border border-critical/40 bg-critical/12 px-2 py-1 text-xs text-critical">
          {error instanceof Error ? error.message : 'Opération impossible.'}
        </p>
      ) : null}

      {/* Le dossier racine n'a pas de ligne à survoler : ses actions vivent ici. */}
      <div className="flex items-center gap-0.5 px-2 pb-1">
        <RootAction
          label="Nouveau fichier à la racine"
          icon={<FilePlus2 size={13} />}
          onClick={() => setDraft({ mode: 'create', parent: '', kind: 'file' })}
        />
        <RootAction
          label="Nouveau dossier à la racine"
          icon={<FolderPlus size={13} />}
          onClick={() => setDraft({ mode: 'create', parent: '', kind: 'directory' })}
        />
      </div>

      <Level path="" depth={0} expanded actions={actions} />
    </div>
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
  onDelete: (path: string, isDirectory: boolean) => void
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
  const { data, isPending, error } = useTreeLevel(actions.conversationId, path, expanded)
  const draft = actions.draft
  const creatingHere = draft?.mode === 'create' && draft.parent === path

  if (!expanded) return null

  if (error) {
    return (
      <p className="px-2 py-1 text-xs text-critical" style={{ paddingLeft: depth * INDENT_PX + 8 }}>
        {error instanceof Error ? error.message : 'Dossier illisible.'}
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
        Lecture...
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
          Dossier vide
        </li>
      ) : null}

      {data.entries.map((entry) => (
        <Entry key={entry.path} entry={entry} depth={depth} actions={actions} />
      ))}
    </ul>
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

  return (
    <li>
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
          onClick={
            entry.isDirectory
              ? () => setOpen((value) => !value)
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

          <span className={cx('min-w-0 flex-1 truncate', state && state.tone)}>{entry.name}</span>

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
                aria-label={`Actions de ${entry.name}`}
                className="flex size-6 items-center justify-center rounded text-ink-faint hover:text-ink"
              >
                <MoreHorizontal size={14} />
              </button>
            }
          >
            {entry.isDirectory ? (
              <>
                <MenuItem
                  icon={<FilePlus2 size={14} />}
                  onSelect={() => {
                    setOpen(true)
                    actions.setDraft({ mode: 'create', parent: entry.path, kind: 'file' })
                  }}
                >
                  Nouveau fichier
                </MenuItem>
                <MenuItem
                  icon={<FolderPlus size={14} />}
                  onSelect={() => {
                    setOpen(true)
                    actions.setDraft({ mode: 'create', parent: entry.path, kind: 'directory' })
                  }}
                >
                  Nouveau dossier
                </MenuItem>
                <MenuSeparator />
              </>
            ) : null}

            <MenuItem
              icon={<Pencil size={14} />}
              onSelect={() =>
                actions.setDraft({ mode: 'rename', path: entry.path, name: entry.name })
              }
            >
              Renommer
            </MenuItem>
            <MenuItem
              icon={<Trash2 size={14} />}
              tone="critical"
              onSelect={() => actions.onDelete(entry.path, entry.isDirectory)}
            >
              Supprimer
            </MenuItem>
          </Menu>
        </div>
      </div>

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
        aria-label="Nom"
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
