import { TooltipButton } from '../ui/Tooltip'
import {
  AtSign,
  ChevronRight,
  ChevronsDownUp,
  CircleAlert,
  ClipboardCopy,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Download,
  FilePlus2,
  FileSymlink,
  FolderPlus,
  Loader,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Scissors,
  Search,
  SquareCheckBig,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { FileState, TreeEntryDto, TreeListingDto } from '@sillage/protocol'
import { formatBytes } from '../../lib/attachments'
import { copyText } from '../../lib/clipboard'
import { referenceInComposer } from '../../lib/composer-ref'
import { hasDraft, moveDocuments } from '../../lib/editor-documents'
import { closeTab, moveTabs, openTab, useEditorTabs } from '../../lib/editor-tabs'
import {
  parentOf,
  siblingPath,
  useCreateEntry,
  useEntryOperations,
  useMoveEntry,
  type EntryOperation,
  type OperationsOutcome,
} from '../../lib/entries'
import { fileIconUrl } from '../../lib/file-icons'
import { downloadArchive, downloadFile } from '../../lib/files-io'
import { translate, useTranslate } from '../../lib/i18n'
import { useFileSearch, useRefreshTree, useTreeLevel } from '../../lib/tree'
import {
  clearSelection,
  clearTreeClipboard,
  collapseAll,
  forgetInView,
  getTreeView,
  isWithin,
  renameInView,
  revealPath,
  selectMany,
  selectOnly,
  setExpanded,
  setTreeClipboard,
  startSelecting,
  toggleSelected,
  topLevelPaths,
  useTreeView,
  type TreeView,
} from '../../lib/tree-view'
import {
  carriesExternalFiles,
  dismissUpload,
  enqueueUploads,
  filesFromDrop,
  registerTreeRefresh,
  useUploads,
  type Upload as UploadItem,
} from '../../lib/uploads'
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

/**
 * Type de transfert du glisser-déposer : il porte les entrées déplacées, en JSON, la
 * sélection entière quand la ligne saisie en fait partie.
 */
const DRAG_TYPE = 'application/x-sillage-entries'

/**
 * Les raccourcis suivent le système, comme dans les explorateurs qu'on y connaît : ⌘ et
 * Option sur Mac, Ctrl ailleurs.
 */
const IS_MAC = navigator.userAgent.includes('Mac')
const MOD = IS_MAC ? '⌘' : 'Ctrl+'
const HINT = { cut: `${MOD}X`, copy: `${MOD}C`, paste: `${MOD}V`, rename: 'F2' }

/** Le libellé de la touche Suppr change avec la langue du clavier, pas celui de ⌘⌫. */
function deleteHint(): string {
  return IS_MAC ? '⌘⌫' : translate('filetree.key.delete')
}

/** Glisser en tenant Option (Mac) ou Ctrl copie au lieu de déplacer, comme sur le bureau. */
function copyModifier(event: { altKey: boolean; ctrlKey: boolean }): boolean {
  return IS_MAC ? event.altKey : event.ctrlKey
}

/** Saisie en cours dans l'arborescence : création d'une entrée, ou renommage. */
type Draft =
  | { mode: 'create'; parent: string; kind: 'file' | 'directory' }
  | { mode: 'rename'; path: string; name: string }

/** Une entrée désignée : son chemin, et si c'est un dossier. */
type Picked = readonly [path: string, isDirectory: boolean]

function nameOf(path: string): string {
  return path.split('/').pop() ?? path
}

/**
 * Ce sur quoi agit un geste fait sur une ligne : toute la sélection si la ligne en fait
 * partie, la ligne seule sinon. C'est la règle des explorateurs de bureau, et elle
 * laisse agir sur une entrée sans perdre ce qu'on avait coché ailleurs.
 */
function targetsOf(view: TreeView, path: string, isDirectory: boolean): Picked[] {
  return view.selection.has(path) ? [...view.selection] : [[path, isDirectory]]
}

/**
 * Dossier où créent les boutons de l'en-tête : celui de la dernière entrée désignée, ou
 * son dossier pour un fichier, comme dans un éditeur de bureau. La racine sinon.
 */
function targetFolderOf(view: TreeView): string {
  const anchor = view.anchor
  if (anchor === null || !view.selection.has(anchor)) return ''
  return view.selection.get(anchor) ? anchor : parentOf(anchor)
}

/**
 * Dernier fichier actif suivi par la sélection, par portée. Hors du composant : la
 * colonne refermée puis rouverte ne doit pas défaire une sélection pour un fichier
 * qu'elle a déjà suivi.
 */
const followed = new Map<string, string>()

export function FileTree({
  scope,
  onOpenFile,
}: {
  scope: string
  /** Referme la colonne quand elle recouvre l'éditeur : sinon le fichier ouvert reste caché. */
  onOpenFile: () => void
}) {
  const t = useTranslate()
  const queryClient = useQueryClient()
  const { active: activePath, paths: openPaths } = useEditorTabs(scope)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [query, setQuery] = useState('')
  /** Entrées dont la suppression est proposée : le geste est sans retour possible. */
  const [pendingDelete, setPendingDelete] = useState<Picked[] | null>(null)
  /**
   * Compte rendu d'un geste qui n'en laisse aucun autre : une copie dans le
   * presse-papiers, ou les échecs d'une action sur plusieurs entrées.
   */
  const [notice, setNotice] = useState<{ tone: 'info' | 'critical'; text: string } | null>(null)
  const create = useCreateEntry(scope)
  const rename = useMoveEntry(scope)
  const operations = useEntryOperations(scope)
  /** Dossier visé par le sélecteur de fichiers, quand il est ouvert depuis un menu. */
  const [uploadInto, setUploadInto] = useState('')
  const picker = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const typeahead = useRef({ text: '', at: 0 })
  /** Profondeur de survol d'un glissement de fichiers, pour cadrer toute la colonne. */
  const [dragDepth, setDragDepth] = useState(0)
  const target = useTreeView(scope, targetFolderOf)

  const error = create.error ?? rename.error

  // Un fichier arrivé dans un dossier replié n'est signalé par aucune veille : c'est ce
  // rafraîchissement qui le fait apparaître à son ouverture.
  const refresh = useRefreshTree(scope)
  useEffect(() => registerTreeRefresh(scope, refresh), [scope, refresh])

  // La sélection suit le fichier affiché, comme dans un éditeur de bureau : ouvert depuis
  // un onglet ou un lien du fil, il est déplié jusqu'à lui et désigné, et c'est sur lui
  // qu'agissent les raccourcis.
  useEffect(() => {
    if (!activePath || followed.get(scope) === activePath) return
    followed.set(scope, activePath)
    revealPath(scope, activePath)
    selectOnly(scope, activePath, false)
  }, [scope, activePath])

  useEffect(() => {
    if (notice?.tone !== 'info') return
    const timer = setTimeout(() => setNotice(null), 2500)
    return () => clearTimeout(timer)
  }, [notice])

  const openPicker = (parent: string) => {
    setUploadInto(parent)
    picker.current?.click()
  }

  const open = (path: string, preview = false) => {
    openTab(scope, path, { preview })
    onOpenFile()
  }

  /** Un renommage ou un déplacement réussi : la vue et les onglets suivent l'entrée. */
  const moved = (from: string, to: string) => {
    renameInView(scope, from, to)
    moveDocuments(scope, from, to)
    moveTabs(scope, from, to)
  }

  /**
   * Une suppression réussie ferme les onglets de ce qui a disparu. Sauf ceux qui portent
   * un brouillon : c'est la dernière copie du travail, et il doit rester récupérable.
   */
  const removed = (paths: string[]) => {
    forgetInView(scope, paths)
    for (const path of openPaths) {
      if (paths.some((gone) => isWithin(path, gone)) && !hasDraft(scope, path)) closeTab(scope, path)
    }
  }

  /** Lance une suite de manipulations, puis reporte leurs effets sur la vue. */
  const run = (list: EntryOperation[], after?: (done: OperationsOutcome['done']) => void) => {
    if (list.length === 0) return
    setNotice(null)
    operations.mutate(list, {
      onSuccess: ({ done, failures }) => {
        for (const { operation } of done) {
          if (operation.kind === 'move') moved(operation.from, operation.to)
        }
        const deleted = done.flatMap(({ operation }) =>
          operation.kind === 'delete' ? [operation.path] : [],
        )
        if (deleted.length > 0) removed(deleted)
        after?.(done)

        const [first, ...others] = failures
        if (first) {
          setNotice({
            tone: 'critical',
            text:
              others.length === 0
                ? first.message
                : t(others.length > 1 ? 'filetree.failures.more.other' : 'filetree.failures.more.one', {
                    message: first.message,
                    count: others.length,
                  }),
          })
        }
      },
    })
  }

  const transfer = (entries: Picked[], toParent: string, mode: 'move' | 'copy') => {
    const kinds = new Map(entries)
    const sources = topLevelPaths(kinds.keys())
      // Déplacer une entrée là où elle est déjà ne ferait rien, qu'une erreur « existe
      // déjà ». La copie, elle, y a un sens : c'est dupliquer.
      .filter((from) => mode === 'copy' || parentOf(from) !== toParent)

    run(
      sources.map((from): EntryOperation =>
        mode === 'copy'
          ? { kind: 'copy', from, toParent }
          : { kind: 'move', from, to: toParent ? `${toParent}/${nameOf(from)}` : nameOf(from) },
      ),
      (done) => {
        // Ce qui vient d'arriver est sélectionné et visible : c'est là que va le regard,
        // et c'est de là que part le geste suivant, renommer la copie par exemple.
        const arrived = done.map(({ operation, path }): Picked => {
          const from = operation.kind === 'delete' ? operation.path : operation.from
          return [path, kinds.get(from) ?? false]
        })
        const first = arrived[0]?.[0]
        if (first) revealPath(scope, first)
        selectMany(scope, arrived, { anchor: first })
      },
    )
  }

  const actions: Actions = {
    scope,
    activePath,
    draft,
    setDraft,
    open,
    onCreate: (parent, name, kind) => {
      setDraft(null)
      create.mutate(
        { parent, name, kind },
        {
          // La nouvelle entrée est désignée, et un fichier s'ouvre : on le crée presque
          // toujours pour l'écrire aussitôt.
          onSuccess: ({ path }) => {
            selectOnly(scope, path, kind === 'directory')
            if (kind === 'file') open(path)
          },
        },
      )
    },
    onRename: (path, name) => {
      setDraft(null)
      const to = siblingPath(path, name)
      if (name !== nameOf(path)) {
        rename.mutate({ from: path, to }, { onSuccess: () => moved(path, to) })
      }
    },
    onTransfer: transfer,
    onDelete: setPendingDelete,
    onClipboard: (mode, entries) => {
      setTreeClipboard(scope, mode, entries)
      const plural = entries.length > 1 ? 'other' : 'one'
      setNotice({
        tone: 'info',
        text: t(`filetree.clipboard.${mode === 'cut' ? 'cut' : 'copied'}.${plural}`, {
          count: entries.length,
        }),
      })
    },
    onPaste: (toParent) => {
      const clipboard = getTreeView(scope).clipboard
      if (!clipboard) return
      transfer([...clipboard.entries], toParent, clipboard.mode === 'cut' ? 'move' : 'copy')
      // Coupé, l'original a quitté sa place : le recoller une seconde fois échouerait.
      if (clipboard.mode === 'cut') clearTreeClipboard(scope)
    },
    onCopyPaths: (paths, absolute) => {
      // La racine vient du premier niveau, toujours chargé quand l'arborescence s'affiche.
      const root = queryClient.getQueryData<TreeListingDto>(['tree', scope, ''])?.root
      const text = paths.map((path) => (absolute && root ? `${root}/${path}` : path)).join('\n')
      void copyText(text).then((ok) =>
        setNotice(
          ok
            ? {
                tone: 'info',
                text: t(paths.length > 1 ? 'filetree.paths.copied.other' : 'filetree.paths.copied.one', {
                  count: paths.length,
                }),
              }
            : { tone: 'critical', text: t('filetree.paths.failed') },
        ),
      )
    },
    onDrop: (parent, transfer) => {
      // Le cadre de dépôt se retire ici et pas seulement à la racine : une ligne qui
      // reçoit le dépôt l'arrête avant elle, et aucun `dragleave` ne suit un `drop`.
      setDragDepth(0)
      // Le dépliage des dossiers déposés est asynchrone : la mise en file attend, pas le
      // gestionnaire d'événement, qui doit rendre la main pour que le navigateur libère
      // le glissement.
      void filesFromDrop(transfer).then((files) => enqueueUploads(scope, parent, files))
    },
    onPickFiles: openPicker,
    rows: () => Array.from(list.current?.querySelectorAll<HTMLElement>('[data-tree-path]') ?? []),
  }

  const startDraft = (kind: 'file' | 'directory') => {
    if (target) setExpanded(scope, target, true)
    setDraft({ mode: 'create', parent: target, kind })
  }

  const searching = query.trim().length >= 2

  return (
    // Toute la colonne accepte les fichiers : viser une ligne de 28 pixels à la souris
    // est déjà difficile, au doigt c'est perdu d'avance. Ce qui ne tombe sur aucun
    // dossier va à la racine du répertoire de travail.
    <div
      className={cx(
        // Colonne pleine hauteur : c'est ce qui permet aux envois de se poser en pied
        // plutôt qu'à la suite des fichiers, et au dépôt d'être accepté partout, y
        // compris sous la dernière ligne.
        'relative flex min-h-full flex-col',
        dragDepth > 0 && 'outline-2 -outline-offset-2 outline-dashed outline-accent',
      )}
      onDragEnter={(event) => {
        if (!carriesExternalFiles(event.dataTransfer)) return
        event.preventDefault()
        setDragDepth((depth) => depth + 1)
      }}
      onDragLeave={(event) => {
        if (!carriesExternalFiles(event.dataTransfer)) return
        setDragDepth((depth) => Math.max(0, depth - 1))
      }}
      onDragOver={(event) => {
        const external = carriesExternalFiles(event.dataTransfer)
        if (!external && !event.dataTransfer.types.includes(DRAG_TYPE)) return
        // Sans ce `preventDefault`, le navigateur refuse le dépôt et retombe sur son
        // comportement par défaut : ouvrir le fichier à la place de la page.
        event.preventDefault()
        event.dataTransfer.dropEffect = external || copyModifier(event) ? 'copy' : 'move'
      }}
      onDrop={(event) => {
        setDragDepth(0)
        if (carriesExternalFiles(event.dataTransfer)) {
          event.preventDefault()
          actions.onDrop('', event.dataTransfer)
          return
        }
        // Une entrée lâchée hors de toute ligne remonte à la racine, comme sur un bureau.
        const dragged = readDragged(event)
        if (!dragged) return
        event.preventDefault()
        actions.onTransfer(dragged, '', copyModifier(event) ? 'copy' : 'move')
      }}
    >
      {/* Sélecteur de fichiers pour le doigt et le clavier : le glisser-déposer n'existe
          pas sur mobile, et le dépôt ne doit pas être la seule voie. */}
      <input
        ref={picker}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          enqueueUploads(scope, uploadInto, files.map((file) => ({ file, relativePath: file.name })))
          // Remis à zéro : sans ça, redéposer le même fichier n'émet pas d'événement.
          event.target.value = ''
        }}
      />

      <div className="flex items-center gap-1 px-2 pb-1">
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs font-medium text-ink-soft">
          {t('filetree.title')}
          {operations.isPending ? <Loader size={11} className="animate-spin text-ink-faint" /> : null}
        </span>
        {/* Les créations visent le dossier de l'entrée désignée, la racine à défaut :
            l'infobulle le nomme, puisque la cible change sans que le bouton bouge. */}
        <RootAction
          label={target ? t('filetree.header.newFileIn', { folder: target }) : t('filetree.root.newFile')}
          icon={<FilePlus2 size={13} />}
          onClick={() => startDraft('file')}
        />
        <RootAction
          label={
            target ? t('filetree.header.newFolderIn', { folder: target }) : t('filetree.root.newFolder')
          }
          icon={<FolderPlus size={13} />}
          onClick={() => startDraft('directory')}
        />
        <RootAction
          label={target ? t('filetree.header.uploadIn', { folder: target }) : t('filetree.root.upload')}
          icon={<Upload size={13} />}
          onClick={() => {
            if (target) setExpanded(scope, target, true)
            openPicker(target)
          }}
        />
        <RootAction
          label={t('filetree.header.collapse')}
          icon={<ChevronsDownUp size={13} />}
          onClick={() => collapseAll(scope)}
        />
        <RootAction label={t('filetree.header.refresh')} icon={<RefreshCw size={13} />} onClick={refresh} />
      </div>
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
              // Descendre dans les résultats sans reprendre la souris.
              if (event.key === 'ArrowDown') {
                event.preventDefault()
                actions.rows()[0]?.focus()
              }
            }}
            placeholder={t('filetree.search.placeholder')}
            aria-label={t('filetree.search.label')}
            className={cx(
              'h-9 w-full rounded-md border border-line bg-sunken pr-6 pl-7',
              'text-[0.8125rem] text-ink placeholder:text-ink-faint',
              'outline-none focus:border-accent',
            )}
          />
          {query ? (
            <TooltipButton
              type="button"
              onClick={() => setQuery('')}
              aria-label={t('filetree.search.clear')}
              className="absolute top-1/2 right-1 -translate-y-1/2 rounded p-0.5 text-ink-faint hover:text-ink"
            >
              <X size={12} />
            </TooltipButton>
          ) : null}
        </div>
      </div>

      <SelectionBar actions={actions} />

      {error ? (
        <p className="mx-2 mb-1 rounded border border-critical/40 bg-critical/12 px-2 py-1 text-xs text-critical">
          {error instanceof Error ? error.message : t('filetree.error.generic')}
        </p>
      ) : null}

      {notice ? (
        <p
          role={notice.tone === 'critical' ? 'alert' : 'status'}
          className={cx(
            'mx-2 mb-1 flex items-start gap-1.5 rounded border px-2 py-1 text-xs',
            notice.tone === 'critical'
              ? 'border-critical/40 bg-critical/12 text-critical'
              : 'border-line bg-sunken text-ink-soft',
          )}
        >
          <span className="min-w-0 flex-1">{notice.text}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label={t('uploads.dismiss')}
            className="shrink-0 rounded p-0.5 opacity-70 hover:opacity-100"
          >
            <X size={11} />
          </button>
        </p>
      ) : null}

      {/* La recherche remplace l'arborescence au lieu de la filtrer sur place : replier
          et déplier des dossiers pour suivre un résultat ferait perdre le fil, et les
          niveaux dépliés doivent être retrouvés intacts en effaçant la recherche. */}
      <div
        ref={list}
        className="flex-1 pb-4"
        onKeyDown={(event) => handleTreeKey(event, actions, typeahead.current)}
        // Un clic dans le vide sous les lignes désélectionne, comme sur un bureau.
        onClick={(event) => {
          if (event.target === event.currentTarget) clearSelection(scope)
        }}
      >
        {searching ? (
          <SearchResults scope={scope} query={query} actions={actions} />
        ) : (
          <Level path="" depth={0} expanded actions={actions} />
        )}
      </div>

      <UploadQueue scope={scope} />

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(next) => {
          if (!next) setPendingDelete(null)
        }}
        title={
          pendingDelete && pendingDelete.length > 1
            ? t('filetree.delete.confirmMany', { count: pendingDelete.length })
            : pendingDelete?.[0]?.[1]
              ? t('filetree.delete.confirmFolder')
              : t('filetree.delete.confirmFile')
        }
        confirmLabel={t('filetree.delete.confirm')}
        tone="critical"
        onConfirm={() => {
          if (pendingDelete) {
            const paths = topLevelPaths(pendingDelete.map(([path]) => path))
            run(paths.map((path): EntryOperation => ({ kind: 'delete', path })))
          }
          setPendingDelete(null)
        }}
      >
        <ul className="max-h-40 overflow-y-auto font-mono text-xs break-all text-ink">
          {pendingDelete?.map(([path]) => <li key={path}>{path}</li>)}
        </ul>
        <p>
          {pendingDelete && pendingDelete.length > 1
            ? t('filetree.delete.bodyMany')
            : pendingDelete?.[0]?.[1]
              ? t('filetree.delete.bodyFolder')
              : t('filetree.delete.bodyFile')}{' '}
          {t('filetree.delete.note')}
        </p>
      </ConfirmDialog>
    </div>
  )
}

/**
 * Raccourcis de l'arborescence, à la manière d'un explorateur de bureau.
 *
 * Posés sur la liste plutôt que sur chaque ligne : la ligne de départ se lit sur la
 * cible de l'événement, et l'ordre des lignes sur le DOM, qui est exactement ce qui est
 * à l'écran, dossiers dépliés et résultats de recherche compris. Le recalculer depuis
 * le cache des niveaux reproduirait ce que le rendu a déjà fait.
 */
function handleTreeKey(
  event: KeyboardEvent,
  actions: Actions,
  typeahead: { text: string; at: number },
): void {
  const row = (event.target as HTMLElement).closest<HTMLElement>('[data-tree-path]')
  // Le champ de renommage vit dans la liste : ses touches lui appartiennent.
  if (!row || event.target instanceof HTMLInputElement) return

  const { scope } = actions
  const rows = actions.rows()
  const index = rows.indexOf(row)
  const [path, isDirectory] = pickedOf(row)
  const view = getTreeView(scope)
  const mod = event.metaKey || event.ctrlKey
  const targets = targetsOf(view, path, isDirectory)

  /** Déplace le curseur ; la sélection suit, s'étend à la Maj, reste en place avec Ctrl. */
  const moveTo = (to: number) => {
    const next = rows[Math.max(0, Math.min(rows.length - 1, to))]
    if (!next) return
    next.focus()
    const [nextPath, nextIsDirectory] = pickedOf(next)
    if (event.shiftKey) selectRange(actions, nextPath, false)
    else if (!mod) selectOnly(scope, nextPath, nextIsDirectory)
  }

  switch (event.key) {
    case 'ArrowDown':
      moveTo(index + 1)
      break
    case 'ArrowUp':
      moveTo(index - 1)
      break
    case 'Home':
      moveTo(0)
      break
    case 'End':
      moveTo(rows.length - 1)
      break
    case 'ArrowRight':
      // Déplie, puis entre dans le dossier déplié.
      if (!isDirectory) return
      if (!view.expanded.has(path)) setExpanded(scope, path, true)
      else if (rows[index + 1]?.dataset.treePath?.startsWith(`${path}/`)) moveTo(index + 1)
      break
    case 'ArrowLeft': {
      // Replie, puis remonte au dossier parent.
      if (isDirectory && view.expanded.has(path)) {
        setExpanded(scope, path, false)
        break
      }
      const parent = rows.findIndex((candidate) => candidate.dataset.treePath === parentOf(path))
      if (parent === -1) return
      moveTo(parent)
      break
    }
    case 'Enter':
      // Sans `preventDefault` plus bas, le bouton recevrait aussi un clic, qui ouvrirait
      // en aperçu ce qu'Entrée ouvre pour de bon.
      if (isDirectory) setExpanded(scope, path, !view.expanded.has(path))
      else actions.open(path)
      break
    case ' ':
      toggleSelected(scope, path, isDirectory)
      break
    case 'F2':
      actions.setDraft({ mode: 'rename', path, name: row.dataset.treeName ?? nameOf(path) })
      break
    case 'Delete':
      actions.onDelete(targets)
      break
    case 'Backspace':
      // ⌘⌫ sur Mac, où le clavier n'a souvent pas de touche Suppr.
      if (!event.metaKey) return
      actions.onDelete(targets)
      break
    case 'Escape': {
      const cut = view.clipboard?.mode === 'cut'
      if (!cut && view.selection.size === 0) return
      if (cut) clearTreeClipboard(scope)
      clearSelection(scope)
      break
    }
    default: {
      if (mod && !event.altKey) {
        const key = event.key.toLowerCase()
        if (key === 'a') selectMany(scope, rows.map(pickedOf))
        else if (key === 'c') actions.onClipboard('copy', targets)
        else if (key === 'x') actions.onClipboard('cut', targets)
        else if (key === 'v') actions.onPaste(isDirectory ? path : parentOf(path))
        else return
        break
      }

      // Taper le début d'un nom y amène, comme dans tout explorateur. Les frappes
      // rapprochées s'additionnent ; une seule lettre répétée passe au suivant.
      if (event.key.length !== 1 || event.altKey) return
      const now = Date.now()
      const text = now - typeahead.at < 700 ? typeahead.text + event.key.toLowerCase() : event.key.toLowerCase()
      typeahead.text = text
      typeahead.at = now
      const start = text.length === 1 ? index + 1 : index
      for (let offset = 0; offset < rows.length; offset += 1) {
        const at = (start + offset) % rows.length
        if (rows[at]?.dataset.treeName?.toLowerCase().startsWith(text)) {
          moveTo(at)
          break
        }
      }
    }
  }
  event.preventDefault()
}

/** Ligne de l'écran sous forme de couple chemin/type, lue sur ses attributs. */
function pickedOf(row: HTMLElement): Picked {
  return [row.dataset.treePath ?? '', row.dataset.treeDir === '1']
}

/**
 * Sélectionne de l'ancre jusqu'à `to`, dans l'ordre de l'écran. Sans ancre visible, la
 * ligne visée devient le point de départ.
 */
function selectRange(actions: Actions, to: string, additive: boolean): void {
  const rows = actions.rows().map(pickedOf)
  const anchor = getTreeView(actions.scope).anchor
  const from = rows.findIndex(([path]) => path === anchor)
  const until = rows.findIndex(([path]) => path === to)
  const target = rows[until]
  if (!target) return
  if (from === -1) {
    selectOnly(actions.scope, ...target)
    return
  }
  const [low, high] = from < until ? [from, until] : [until, from]
  selectMany(actions.scope, rows.slice(low, high + 1), { additive })
}

/**
 * Sélection au clic, à la manière des explorateurs de bureau : Ctrl (⌘ sur Mac) coche
 * ou décoche, Maj étend depuis le dernier clic. En mode sélection, un simple appui
 * coche : au doigt, il n'y a pas de touche à tenir.
 *
 * Rend vrai quand le clic s'arrête à la sélection, sans ouvrir ni déplier.
 */
function selectFromClick(event: MouseEvent, entry: TreeEntryDto, actions: Actions): boolean {
  const { scope } = actions
  const additive = event.metaKey || event.ctrlKey
  // Safari ne donne pas le focus à un bouton cliqué : sans ça, les flèches partiraient
  // de la ligne précédente, ou de nulle part.
  if (event.currentTarget instanceof HTMLElement) event.currentTarget.focus({ preventScroll: true })
  if (event.shiftKey) {
    selectRange(actions, entry.path, additive)
    return true
  }
  if (additive || getTreeView(scope).selecting) {
    toggleSelected(scope, entry.path, entry.isDirectory)
    return true
  }
  selectOnly(scope, entry.path, entry.isDirectory)
  return false
}

/** Entrées glissées depuis l'arborescence, ou null pour un autre glissement. */
function readDragged(event: DragEvent): Picked[] | null {
  const raw = event.dataTransfer.getData(DRAG_TYPE)
  if (!raw) return null
  try {
    return JSON.parse(raw) as Picked[]
  } catch {
    return null
  }
}

/**
 * Pastille « 3 éléments » sous le curseur pendant un glissement de plusieurs entrées :
 * l'image par défaut ne montrerait que la ligne saisie, et laisserait croire qu'elle
 * part seule.
 */
function setDragBadge(event: DragEvent, label: string): void {
  const badge = document.createElement('div')
  badge.textContent = label
  badge.style.cssText =
    'position:fixed;top:-100px;left:0;padding:2px 8px;border-radius:6px;font:12px system-ui;' +
    'background:var(--sg-accent);color:var(--sg-accent-ink)'
  document.body.append(badge)
  event.dataTransfer.setDragImage(badge, -8, -8)
  // L'image est capturée à l'appel : l'élément peut partir au tour suivant.
  setTimeout(() => badge.remove())
}

/**
 * Barre des actions sur la sélection, dès que plusieurs entrées sont cochées.
 *
 * Le clic droit les propose aussi, mais rien ne dit qu'il existe ; et au doigt, cette
 * barre est la seule voie, le mode sélection ne laissant plus l'appui ouvrir un menu.
 */
function SelectionBar({ actions }: { actions: Actions }) {
  const t = useTranslate()
  const { scope } = actions
  const count = useTreeView(scope, (view) => view.selection.size)
  const selecting = useTreeView(scope, (view) => view.selecting)
  if (count < 2 && !selecting) return null

  const targets = () => [...getTreeView(scope).selection]

  return (
    <div
      role="toolbar"
      aria-label={t('filetree.selection.aria')}
      className="mx-2 mb-1.5 flex items-center gap-px rounded-md border border-accent/40 bg-accent-wash pr-0.5 pl-2"
    >
      <span className="min-w-0 flex-1 truncate text-xs font-medium whitespace-nowrap text-ink">
        {t(count > 1 ? 'filetree.selection.count.other' : 'filetree.selection.count.one', { count })}
      </span>
      <RootAction
        compact
        label={t('filetree.entry.cut')}
        icon={<Scissors size={13} />}
        onClick={() => actions.onClipboard('cut', targets())}
      />
      <RootAction
        compact
        label={t('filetree.entry.copy')}
        icon={<Copy size={13} />}
        onClick={() => actions.onClipboard('copy', targets())}
      />
      <RootAction
        compact
        label={t('filetree.entry.downloadZip')}
        icon={<Download size={13} />}
        onClick={() => {
          const picked = targets()
          // Un fichier seul se télécharge tel quel : l'emballer n'apporterait rien.
          const [only] = picked
          if (picked.length === 1 && only && !only[1]) downloadFile(scope, only[0])
          else downloadArchive(scope, picked.map(([path]) => path))
        }}
      />
      <RootAction
        compact
        label={t('filetree.selection.delete', { count })}
        icon={<Trash2 size={13} />}
        onClick={() => actions.onDelete(targets())}
      />
      <RootAction
        compact
        label={t('filetree.selection.clear')}
        icon={<X size={13} />}
        onClick={() => clearSelection(scope)}
      />
    </div>
  )
}

/**
 * Envois en cours, en pied de colonne.
 *
 * Collé au bas plutôt qu'en tête : l'arborescence reste au même endroit pendant qu'un
 * dossier monte, et le fichier qu'on vient de déposer apparaît à sa place sans que la
 * liste ne saute. Un envoi réussi s'efface tout seul ; une erreur attend d'être lue.
 */
function UploadQueue({ scope }: { scope: string }) {
  const t = useTranslate()
  const uploads = useUploads(scope)
  if (uploads.length === 0) return null

  return (
    <ul className="sticky bottom-0 z-10 mt-auto border-t border-line bg-surface px-2 py-1.5">
      {uploads.map((upload) => (
        <li key={upload.id} className="flex flex-col gap-0.5 py-0.5">
          <div className="flex items-baseline gap-1.5 text-[0.6875rem]">
            <span
              className={cx(
                'min-w-0 flex-1 truncate',
                upload.status === 'error' ? 'text-critical' : 'text-ink-soft',
              )}
              title={upload.path}
            >
              {upload.label}
            </span>
            <span className="shrink-0 text-ink-faint">{statusOf(upload)}</span>
            <TooltipButton
              type="button"
              onClick={() => dismissUpload(upload.id)}
              aria-label={
                upload.status === 'sending' || upload.status === 'pending'
                  ? t('uploads.cancel')
                  : t('uploads.dismiss')
              }
              className="shrink-0 rounded p-0.5 text-ink-faint hover:text-ink"
            >
              <X size={11} />
            </TooltipButton>
          </div>

          {upload.status === 'error' ? (
            <p className="flex items-start gap-1 text-[0.6875rem] text-critical">
              <CircleAlert size={11} className="mt-0.5 shrink-0" />
              <span className="min-w-0">{upload.error}</span>
            </p>
          ) : (
            // Une taille nulle n'a pas de fraction : la barre reste pleine plutôt que de
            // diviser par zéro, le fichier étant de toute façon déjà écrit.
            <div className="h-1 overflow-hidden rounded-full bg-surface-high">
              <div
                className={cx(
                  'h-full rounded-full transition-[width]',
                  upload.status === 'done' ? 'bg-positive' : 'bg-accent',
                )}
                style={{ width: `${percentOf(upload)}%` }}
              />
            </div>
          )}
        </li>
      ))}
    </ul>
  )
}

function percentOf(upload: UploadItem): number {
  if (upload.status === 'done' || upload.sizeBytes === 0) return 100
  return Math.min(100, Math.round((upload.sentBytes / upload.sizeBytes) * 100))
}

function statusOf(upload: UploadItem): string {
  if (upload.status === 'error') return translate('uploads.status.error')
  if (upload.status === 'done') return translate('uploads.status.done')
  if (upload.status === 'pending') return translate('uploads.status.pending')
  return translate('uploads.status.sending', {
    sent: formatBytes(upload.sentBytes),
    total: formatBytes(upload.sizeBytes),
  })
}

/** Résultats plats : un chemin complet dit mieux d'où vient un fichier qu'une indentation. */
function SearchResults({
  scope,
  query,
  actions,
}: {
  scope: string
  query: string
  actions: Actions
}) {
  const t = useTranslate()
  const { data, isPending, error } = useFileSearch(scope, query)

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
    <ul role="tree" aria-label={t('filetree.title')} aria-multiselectable>
      {data.entries.map((entry) => (
        <li key={entry.path} role="none">
          <EntryRow entry={entry} actions={actions}>
            <span className="flex min-w-0 flex-1 flex-col text-left leading-tight">
              <span className="truncate text-[0.8125rem] text-ink-soft">{entry.name}</span>
              <span className="truncate text-[0.6875rem] text-ink-faint">{entry.path}</span>
            </span>
          </EntryRow>
        </li>
      ))}

      {data.truncated ? (
        <li role="none" className="px-2 py-1.5 text-[0.6875rem] text-ink-faint">
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
  compact = false,
}: {
  label: string
  icon: React.ReactNode
  onClick: () => void
  /** Plus serré à la souris : la barre de sélection loge aussi le compte. */
  compact?: boolean
}) {
  return (
    <TooltipButton
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cx(
        'flex size-11 shrink-0 pointer-coarse:size-11 items-center justify-center rounded',
        'text-ink-faint transition-colors hover:bg-surface-high hover:text-ink',
        compact ? 'md:size-6' : 'md:size-7',
      )}
    >
      {icon}
    </TooltipButton>
  )
}

/**
 * Ce que les lignes peuvent déclencher.
 *
 * Passé en bloc plutôt qu'une prop par action : l'arborescence est récursive, et
 * une douzaine de props traverseraient chaque niveau sans que celui-ci les regarde.
 * La sélection n'y est pas : chaque ligne lit la sienne dans `tree-view`.
 */
interface Actions {
  scope: string
  activePath: string | null
  draft: Draft | null
  setDraft: (draft: Draft | null) => void
  /** Ouvre un fichier ; en aperçu, il cède sa place au suivant, voir `openTab`. */
  open: (path: string, preview?: boolean) => void
  onCreate: (parent: string, name: string, kind: 'file' | 'directory') => void
  onRename: (path: string, name: string) => void
  /** Déplace ou copie des entrées dans `toParent`. */
  onTransfer: (entries: Picked[], toParent: string, mode: 'move' | 'copy') => void
  /** Propose la suppression, qui attend une confirmation. */
  onDelete: (entries: Picked[]) => void
  onClipboard: (mode: 'copy' | 'cut', entries: Picked[]) => void
  onPaste: (toParent: string) => void
  onCopyPaths: (paths: string[], absolute: boolean) => void
  /** Fichiers lâchés depuis le système sur `parent`, dossiers compris. */
  onDrop: (parent: string, transfer: DataTransfer) => void
  /** Ouvre le sélecteur de fichiers, à destination de `parent`. */
  onPickFiles: (parent: string) => void
  /** Lignes affichées, dans l'ordre de l'écran : la base du clavier et de la Maj. */
  rows: () => HTMLElement[]
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
  const { data, isPending, error } = useTreeLevel(actions.scope, path, expanded)
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
    <ul
      {...(depth === 0
        ? { role: 'tree', 'aria-label': t('filetree.title'), 'aria-multiselectable': true }
        : { role: 'group' })}
    >
      {creatingHere ? (
        <li role="none">
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
          role="none"
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
  /** Les actions d'un même groupe se suivent ; un trait sépare deux groupes. */
  group: string
  icon: ReactNode
  label: string
  /** Raccourci clavier équivalent, rappelé en bout de ligne. */
  hint?: string
  tone?: 'critical'
  run: () => void
}

/**
 * Les actions d'une entrée seule, en données plutôt qu'en éléments.
 *
 * Elles s'affichent à deux endroits, au clic droit et derrière les trois points, et
 * les deux menus viennent de modules Radix distincts dont les éléments ne se
 * partagent pas. Décrire les actions une fois et les rendre deux fois évite que les
 * deux listes divergent.
 */
function entryActions(entry: TreeEntryDto, actions: Actions, view: TreeView): EntryAction[] {
  const { scope } = actions
  const self: Picked[] = [[entry.path, entry.isDirectory]]
  const expand = () => setExpanded(scope, entry.path, true)
  // « Sélectionner » n'est utile qu'au doigt : à la souris, Ctrl-clic fait la même chose.
  const touch = window.matchMedia('(pointer: coarse)').matches

  return [
    ...(entry.isDirectory
      ? [
          {
            key: 'new-file',
            group: 'create',
            icon: <FilePlus2 size={14} />,
            label: translate('filetree.entry.newFile'),
            run: () => {
              expand()
              actions.setDraft({ mode: 'create', parent: entry.path, kind: 'file' })
            },
          },
          {
            key: 'new-dir',
            group: 'create',
            icon: <FolderPlus size={14} />,
            label: translate('filetree.entry.newFolder'),
            run: () => {
              expand()
              actions.setDraft({ mode: 'create', parent: entry.path, kind: 'directory' })
            },
          },
          {
            key: 'upload',
            group: 'create',
            icon: <Upload size={14} />,
            label: translate('filetree.entry.upload'),
            run: () => {
              expand()
              actions.onPickFiles(entry.path)
            },
          },
        ]
      : [
          {
            key: 'open',
            group: 'open',
            icon: <FileSymlink size={14} />,
            label: translate('filetree.entry.open'),
            run: () => actions.open(entry.path),
          },
          {
            key: 'download',
            group: 'open',
            icon: <Download size={14} />,
            label: translate('filetree.entry.download'),
            run: () => downloadFile(scope, entry.path),
          },
          {
            key: 'reference',
            group: 'open',
            icon: <AtSign size={14} />,
            label: translate('filetree.entry.reference'),
            run: () => referenceInComposer(entry.path),
          },
        ]),
    {
      key: 'cut',
      group: 'clipboard',
      icon: <Scissors size={14} />,
      label: translate('filetree.entry.cut'),
      hint: HINT.cut,
      run: () => actions.onClipboard('cut', self),
    },
    {
      key: 'copy',
      group: 'clipboard',
      icon: <Copy size={14} />,
      label: translate('filetree.entry.copy'),
      hint: HINT.copy,
      run: () => actions.onClipboard('copy', self),
    },
    // Coller dans un dossier, ou à côté d'un fichier : c'est là qu'on a cliqué.
    ...(view.clipboard
      ? [
          {
            key: 'paste',
            group: 'clipboard',
            icon: <ClipboardPaste size={14} />,
            label: translate('filetree.entry.paste'),
            hint: HINT.paste,
            run: () => actions.onPaste(entry.isDirectory ? entry.path : parentOf(entry.path)),
          },
        ]
      : []),
    {
      key: 'duplicate',
      group: 'clipboard',
      icon: <CopyPlus size={14} />,
      label: translate('filetree.entry.duplicate'),
      run: () => actions.onTransfer(self, parentOf(entry.path), 'copy'),
    },
    ...(entry.isDirectory
      ? [
          {
            key: 'download',
            group: 'transfer',
            icon: <Download size={14} />,
            label: translate('filetree.entry.downloadZip'),
            run: () => downloadArchive(scope, [entry.path]),
          },
        ]
      : []),
    {
      key: 'copy-path',
      group: 'path',
      icon: <ClipboardCopy size={14} />,
      label: translate('filetree.entry.copyPath'),
      run: () => actions.onCopyPaths([entry.path], true),
    },
    {
      key: 'copy-relative-path',
      group: 'path',
      icon: <ClipboardCopy size={14} />,
      label: translate('filetree.entry.copyRelativePath'),
      run: () => actions.onCopyPaths([entry.path], false),
    },
    ...(touch
      ? [
          {
            key: 'select',
            group: 'edit',
            icon: <SquareCheckBig size={14} />,
            label: translate('filetree.entry.select'),
            run: () => startSelecting(scope, entry.path, entry.isDirectory),
          },
        ]
      : []),
    {
      key: 'rename',
      group: 'edit',
      icon: <Pencil size={14} />,
      label: translate('filetree.entry.rename'),
      hint: HINT.rename,
      run: () => actions.setDraft({ mode: 'rename', path: entry.path, name: entry.name }),
    },
    {
      key: 'delete',
      group: 'edit',
      icon: <Trash2 size={14} />,
      label: translate('filetree.entry.delete'),
      hint: deleteHint(),
      tone: 'critical' as const,
      run: () => actions.onDelete(self),
    },
  ]
}

/** Les actions d'une sélection de plusieurs entrées, quand la ligne visée en fait partie. */
function selectionActions(targets: Picked[], actions: Actions): EntryAction[] {
  const { scope } = actions
  const paths = targets.map(([path]) => path)
  const files = targets.filter(([, isDirectory]) => !isDirectory).map(([path]) => path)

  return [
    {
      key: 'cut',
      group: 'clipboard',
      icon: <Scissors size={14} />,
      label: translate('filetree.entry.cut'),
      hint: HINT.cut,
      run: () => actions.onClipboard('cut', targets),
    },
    {
      key: 'copy',
      group: 'clipboard',
      icon: <Copy size={14} />,
      label: translate('filetree.entry.copy'),
      hint: HINT.copy,
      run: () => actions.onClipboard('copy', targets),
    },
    {
      key: 'download',
      group: 'transfer',
      icon: <Download size={14} />,
      label: translate('filetree.entry.downloadZip'),
      run: () => downloadArchive(scope, paths),
    },
    // Les dossiers n'ont pas de mention `@` à eux dans l'explorateur : seuls les
    // fichiers de la sélection partent dans la barre de saisie.
    ...(files.length > 0
      ? [
          {
            key: 'reference',
            group: 'transfer',
            icon: <AtSign size={14} />,
            label: translate('filetree.selection.reference'),
            run: () => files.forEach((path) => referenceInComposer(path)),
          },
        ]
      : []),
    {
      key: 'copy-paths',
      group: 'transfer',
      icon: <ClipboardCopy size={14} />,
      label: translate('filetree.selection.copyPaths'),
      run: () => actions.onCopyPaths(paths, false),
    },
    {
      key: 'clear',
      group: 'edit',
      icon: <X size={14} />,
      label: translate('filetree.selection.clear'),
      run: () => clearSelection(scope),
    },
    {
      key: 'delete',
      group: 'edit',
      icon: <Trash2 size={14} />,
      label: translate('filetree.selection.delete', { count: targets.length }),
      hint: deleteHint(),
      tone: 'critical' as const,
      run: () => actions.onDelete(targets),
    },
  ]
}

/**
 * Le contenu des deux menus d'une ligne. Lu à l'ouverture, puisque Radix ne le monte
 * qu'à ce moment : la sélection et le presse-papiers y sont ceux de l'instant.
 */
function EntryMenuItems({
  entry,
  actions,
  variant,
}: {
  entry: TreeEntryDto
  actions: Actions
  variant: 'context' | 'dropdown'
}) {
  const view = getTreeView(actions.scope)
  const targets = targetsOf(view, entry.path, entry.isDirectory)
  const list = targets.length > 1 ? selectionActions(targets, actions) : entryActions(entry, actions, view)
  const Item = variant === 'context' ? ContextMenuItem : MenuItem
  const Separator = variant === 'context' ? ContextMenuSeparator : MenuSeparator

  return (
    <>
      {list.map((action, index) => (
        <Fragment key={action.key}>
          {index > 0 && list[index - 1]?.group !== action.group ? <Separator /> : null}
          <Item icon={action.icon} tone={action.tone} hint={action.hint} onSelect={action.run}>
            {action.label}
          </Item>
        </Fragment>
      ))}
    </>
  )
}

/** Fond d'une ligne : la sélection d'abord, puis le fichier ouvert, puis le survol. */
function rowTone(selected: boolean, active: boolean): string {
  if (selected) return 'bg-accent-wash text-ink'
  if (active) return 'bg-accent-wash/45'
  return 'hover:bg-surface-high'
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
  const selected = useTreeView(actions.scope, (view) => view.selection.has(entry.path))
  const active = actions.activePath === entry.path

  return (
    <ContextMenu
      trigger={
        <button
          type="button"
          role="treeitem"
          aria-selected={selected}
          aria-current={active ? true : undefined}
          data-tree-path={entry.path}
          data-tree-name={entry.name}
          onMouseDown={(event) => {
            // Maj-clic étend la sélection : sans ça, il sélectionnerait aussi du texte.
            if (event.shiftKey) event.preventDefault()
          }}
          onClick={(event) => {
            if (!selectFromClick(event, entry, actions)) actions.open(entry.path, true)
          }}
          onDoubleClick={(event) => {
            if (event.shiftKey || event.metaKey || event.ctrlKey) return
            actions.open(entry.path)
          }}
          className={cx(
            'flex w-full min-w-0 items-center gap-1.5 px-2 py-1 text-left select-none',
            // L'anneau de focus global, rentré dans la ligne : la colonne le rognerait.
            'transition-colors focus-visible:-outline-offset-2',
            rowTone(selected, active),
          )}
        >
          <img src={fileIconUrl(entry.name, false)} alt="" aria-hidden className="size-4 shrink-0" />
          {children}
        </button>
      }
    >
      <EntryMenuItems entry={entry} actions={actions} variant="context" />
    </ContextMenu>
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
  const { scope } = actions
  const open = useTreeView(scope, (view) => entry.isDirectory && view.expanded.has(entry.path))
  const selected = useTreeView(scope, (view) => view.selection.has(entry.path))
  const cut = useTreeView(
    scope,
    (view) => view.clipboard?.mode === 'cut' && view.clipboard.entries.has(entry.path),
  )
  const [dropping, setDropping] = useState(false)
  const active = actions.activePath === entry.path
  const button = useRef<HTMLButtonElement>(null)
  const state = entry.state ? STATES[entry.state] : null
  const draft = actions.draft

  // Le fichier affiché dans l'éditeur se montre : ouvert depuis un onglet ou un lien du
  // fil, il peut se trouver loin dans une liste qu'on n'a pas fait défiler.
  useEffect(() => {
    if (active) button.current?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (draft?.mode === 'rename' && draft.path === entry.path) {
    return (
      <li role="none">
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
    // Le dépôt s'arrête ici : sans quoi la colonne, qui accepte aussi les fichiers,
    // les enverrait une seconde fois à la racine.
    event.stopPropagation()
    setDropping(false)

    // Des fichiers venus du système, et non une entrée déplacée dans l'arborescence :
    // un dossier les reçoit, un fichier les envoie à son dossier parent.
    if (carriesExternalFiles(event.dataTransfer)) {
      actions.onDrop(dropTarget, event.dataTransfer)
      return
    }

    // Déposer un dossier sur lui-même ou dans sa propre descendance n'a pas de sens :
    // le serveur le refuse, mais autant ne pas envoyer la requête.
    const dragged = readDragged(event)?.filter(([from]) => !isWithin(dropTarget, from))
    if (dragged?.length) actions.onTransfer(dragged, dropTarget, copyModifier(event) ? 'copy' : 'move')
  }

  return (
    <li role="none">
      <ContextMenu
        trigger={
          <div
            className={cx(
              'group/entry flex items-center transition-colors',
              dropping ? 'bg-accent-wash' : rowTone(selected, active),
              cut && 'opacity-50',
            )}
            draggable
            onDragStart={(event) => {
              // La sélection part entière quand la ligne saisie en fait partie.
              const dragged = targetsOf(getTreeView(scope), entry.path, entry.isDirectory)
              event.dataTransfer.setData(DRAG_TYPE, JSON.stringify(dragged))
              event.dataTransfer.effectAllowed = 'copyMove'
              if (dragged.length > 1) {
                setDragBadge(event, translate('filetree.drag.count', { count: dragged.length }))
              }
            }}
            onDragOver={(event) => {
              const external = carriesExternalFiles(event.dataTransfer)
              // Sans `preventDefault`, le navigateur refuse le dépôt sans rien dire.
              if (!external && !event.dataTransfer.types.includes(DRAG_TYPE)) return
              event.preventDefault()
              event.dataTransfer.dropEffect = external || copyModifier(event) ? 'copy' : 'move'
              setDropping(true)
            }}
            onDragLeave={() => setDropping(false)}
            onDrop={onDrop}
          >
            <button
              ref={button}
              type="button"
              role="treeitem"
              aria-level={depth + 1}
              aria-selected={selected}
              aria-expanded={entry.isDirectory ? open : undefined}
              aria-current={active ? true : undefined}
              data-tree-path={entry.path}
              data-tree-dir={entry.isDirectory ? '1' : undefined}
              data-tree-name={entry.name}
              onMouseDown={(event) => {
                // Maj-clic étend la sélection : sans ça, il sélectionnerait aussi du texte.
                if (event.shiftKey) event.preventDefault()
              }}
              /*
               * Un dossier se déplie au clic simple, un fichier s'ouvre. C'est le geste
               * attendu de part et d'autre, et l'arborescence reste visible à côté de
               * l'éditeur, donc ouvrir ne coûte plus de quitter ce qu'on parcourt.
               *
               * Le clic simple ouvre un aperçu, remplacé par le fichier suivant : sans
               * ça, parcourir l'arborescence remplit la barre d'onglets. Le double clic
               * ouvre pour de bon, comme dans un éditeur. Avec Ctrl ou Maj, le clic ne
               * fait que sélectionner.
               */
              onClick={(event) => {
                if (selectFromClick(event, entry, actions)) return
                if (entry.isDirectory) setExpanded(scope, entry.path, !open)
                else actions.open(entry.path, true)
              }}
              onDoubleClick={(event) => {
                if (entry.isDirectory || event.shiftKey || event.metaKey || event.ctrlKey) return
                if (getTreeView(scope).selecting) return
                actions.open(entry.path)
              }}
              className={cx(
                'flex h-7 min-w-0 flex-1 items-center gap-1.5 text-left text-[0.8125rem] select-none',
                // L'anneau de focus global, rentré dans la ligne : la colonne le rognerait.
                'focus-visible:-outline-offset-2',
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
                  <TooltipButton
                    type="button"
                    aria-label={t('filetree.entry.actions', { name: entry.name })}
                    className="flex size-11 md:size-7 pointer-coarse:size-11 items-center justify-center rounded text-ink-faint hover:text-ink"
                  >
                    <MoreHorizontal size={14} />
                  </TooltipButton>
                }
              >
                <EntryMenuItems entry={entry} actions={actions} variant="dropdown" />
              </Menu>
            </div>
          </div>
        }
      >
        <EntryMenuItems entry={entry} actions={actions} variant="context" />
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
