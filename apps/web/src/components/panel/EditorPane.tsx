import { Code2, Eye, Loader, MoreHorizontal, Save, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  VIEWABLE_DOCUMENT_TYPES,
  VIEWABLE_IMAGE_TYPES,
  type FileContentDto,
} from '@sillage/protocol'
import { ApiRequestError } from '../../lib/api'
import {
  activateTab,
  closeOtherTabs,
  closeTab,
  reorderTabs,
  useEditorTabs,
} from '../../lib/editor-tabs'
import { fileIconUrl } from '../../lib/file-icons'
import { languageFromPath } from '../../lib/highlight'
import { rawFileUrl, readFile, writeFile } from '../../lib/files-io'
import { useTranslate } from '../../lib/i18n'
import { isMarkdownPath, setMarkdownView, useMarkdownView } from '../../lib/markdown-view'
import { Markdown } from '../chat/Markdown'
import { Banner, Menu, MenuItem, cx } from '../ui'
import { CodeEditor } from './CodeEditor'

/** Type de transfert du glisser-déposer des onglets, distinct de celui de l'arborescence. */
const TAB_DRAG_TYPE = 'application/x-sillage-tab'

/** Onglets ouverts, et le fichier actif en dessous. */
export function EditorPane({ conversationId }: { conversationId: string }) {
  const { paths, active } = useEditorTabs(conversationId)
  /** Onglets dont le contenu diverge du disque, pour la pastille de la barre. */
  const [dirty, setDirty] = useState<Set<string>>(() => new Set())
  const t = useTranslate()

  const markDirty = useCallback((path: string, isDirty: boolean) => {
    setDirty((current) => {
      if (current.has(path) === isDirty) return current
      const next = new Set(current)
      if (isDirty) next.add(path)
      else next.delete(path)
      return next
    })
  }, [])

  if (paths.length === 0) {
    return (
      <p className="px-4 py-8 text-center text-sm text-ink-faint">{t('editor.empty')}</p>
    )
  }

  const close = (path: string) => {
    closeTab(conversationId, path)
    markDirty(path, false)
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex shrink-0 items-center border-b border-line">
        <div className="flex min-w-0 flex-1 items-center gap-px overflow-x-auto">
          {paths.map((path, index) => (
            <Tab
              key={path}
              path={path}
              index={index}
              active={path === active}
              dirty={dirty.has(path)}
              onActivate={() => activateTab(conversationId, path)}
              onClose={() => close(path)}
              onDropAt={(from) => reorderTabs(conversationId, from, index)}
            />
          ))}
        </div>

        <Menu
          trigger={
            <button
              type="button"
              aria-label={t('editor.tabs.actions')}
              className="flex size-8 shrink-0 items-center justify-center border-l border-line text-ink-faint hover:text-ink"
            >
              <MoreHorizontal size={14} />
            </button>
          }
        >
          <MenuItem
            icon={<X size={14} />}
            disabled={active === null || paths.length < 2}
            onSelect={() => closeOtherTabs(conversationId, active)}
          >
            {t('editor.tabs.closeOthers')}
          </MenuItem>
          <MenuItem icon={<X size={14} />} onSelect={() => closeOtherTabs(conversationId, null)}>
            {t('editor.tabs.closeAll')}
          </MenuItem>
        </Menu>
      </div>

      {/* Un onglet par fichier, monté seul : garder les autres en vie retiendrait
          autant d'éditeurs CodeMirror que d'onglets ouverts. Le contenu non
          enregistré d'un onglet inactif est donc perdu, et la pastille le signale
          tant qu'il est actif. */}
      {active ? (
        <FileView
          key={active}
          conversationId={conversationId}
          path={active}
          markDirty={markDirty}
        />
      ) : null}
    </div>
  )
}

/**
 * Un onglet, déplaçable par glissement.
 *
 * L'ordre d'ouverture ne dit rien de l'usage : on regroupe volontiers ce qui va
 * ensemble. Le clic du milieu ferme, comme dans un navigateur.
 */
function Tab({
  path,
  index,
  active,
  dirty,
  onActivate,
  onClose,
  onDropAt,
}: {
  path: string
  index: number
  active: boolean
  dirty: boolean
  onActivate: () => void
  onClose: () => void
  onDropAt: (from: string) => void
}) {
  const [dropping, setDropping] = useState(false)
  const t = useTranslate()

  return (
    <div
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(TAB_DRAG_TYPE, path)
        event.dataTransfer.effectAllowed = 'move'
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes(TAB_DRAG_TYPE)) return
        // Sans `preventDefault`, le navigateur refuse le dépôt sans rien dire.
        event.preventDefault()
        setDropping(true)
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={(event) => {
        event.preventDefault()
        setDropping(false)
        const from = event.dataTransfer.getData(TAB_DRAG_TYPE)
        if (from && from !== path) onDropAt(from)
      }}
      onAuxClick={(event) => {
        if (event.button === 1) onClose()
      }}
      className={cx(
        'group/tab flex h-8 shrink-0 items-center gap-1.5 border-r border-line pr-1 pl-2',
        active ? 'bg-surface text-ink' : 'bg-sunken text-ink-faint',
        dropping && 'border-l-2 border-l-accent',
      )}
      title={path}
      data-index={index}
    >
      <button type="button" onClick={onActivate} className="flex min-w-0 items-center gap-1.5">
        <img
          src={fileIconUrl(path.split('/').pop() ?? path, false)}
          alt=""
          aria-hidden
          className="size-4 shrink-0"
        />
        <span className="max-w-40 truncate text-xs">{path.split('/').pop()}</span>
      </button>

      {dirty ? (
        <span aria-label={t('editor.tab.unsaved')} className="size-1.5 shrink-0 rounded-full bg-accent" />
      ) : null}

      <button
        type="button"
        onClick={onClose}
        aria-label={t('editor.tab.close', { path })}
        className="rounded p-0.5 text-ink-faint opacity-0 hover:text-ink group-hover/tab:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
      >
        <X size={12} />
      </button>
    </div>
  )
}

function FileView({
  conversationId,
  path,
  markDirty,
}: {
  conversationId: string
  path: string
  /** Stable d'un rendu à l'autre : une fonction recréée relancerait la lecture en boucle. */
  markDirty: (path: string, dirty: boolean) => void
}) {
  const [file, setFile] = useState<FileContentDto | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [saving, setSaving] = useState(false)
  /** Contenu courant de l'éditeur. Dans une ref : le retenir en état remonterait
      l'éditeur à chaque frappe, puisque son contenu initial est une prop. */
  const draft = useRef('')
  const extension = languageFromPath(path)
  const isImage = extension in VIEWABLE_IMAGE_TYPES
  const isDocument = extension in VIEWABLE_DOCUMENT_TYPES
  const isMarkdown = isMarkdownPath(path)
  const view = useMarkdownView()
  const t = useTranslate()

  const load = useCallback(async () => {
    setError(null)
    setConflict(false)
    try {
      const loaded = await readFile(conversationId, path)
      draft.current = loaded.content
      setFile(loaded)
      markDirty(path, false)
    } catch (err) {
      setFile(null)
      setError(err instanceof Error ? err.message : t('editor.error.read'))
    }
  }, [conversationId, path, markDirty, t])

  /** Servi tel quel par l'API, sans passer par la lecture texte. */
  const rawView = isImage || isDocument
  useEffect(() => {
    if (!rawView) void load()
  }, [rawView, load])

  /** `force` écrase sciemment ce qui est sur le disque, après un conflit affiché. */
  const save = useCallback(
    async (force: boolean) => {
      if (!file) return
      setSaving(true)
      setError(null)
      try {
        const { fingerprint } = await writeFile(
          conversationId,
          path,
          draft.current,
          force ? null : file.fingerprint,
        )
        setFile({ ...file, fingerprint })
        setConflict(false)
        markDirty(path, false)
      } catch (err) {
        // Le conflit n'est pas une erreur d'écriture : c'est une décision à prendre,
        // donc il se présente comme telle plutôt que comme un échec. Reconnu par le
        // code de l'API et non par son message, qui n'est fait que pour être lu.
        if (err instanceof ApiRequestError && err.code === 'stale_write') setConflict(true)
        else setError(err instanceof Error ? err.message : t('editor.error.write'))
      } finally {
        setSaving(false)
      }
    },
    [conversationId, path, file, markDirty, t],
  )

  if (isImage) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        <img
          src={rawFileUrl(conversationId, path)}
          alt={path}
          className="max-h-full max-w-full object-contain"
        />
      </div>
    )
  }

  // La visionneuse du navigateur plutôt qu'un moteur de rendu embarqué : elle sait
  // déjà paginer, chercher et imprimer, pour rien de plus à charger.
  if (isDocument) {
    return (
      <iframe
        src={rawFileUrl(conversationId, path)}
        title={path}
        className="min-h-0 min-w-0 flex-1 border-0 bg-canvas"
      />
    )
  }

  if (error) {
    return (
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <Banner>{error}</Banner>
      </div>
    )
  }

  if (!file) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-ink-faint">
        <Loader size={20} className="animate-spin" aria-label={t('editor.loading')} />
      </div>
    )
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {conflict ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-caution/40 bg-caution/12 px-3 py-2 text-xs text-caution">
          <span className="flex-1">{t('editor.conflict.message')}</span>
          <button type="button" onClick={() => void load()} className="font-medium underline">
            {t('editor.conflict.reload')}
          </button>
          <button type="button" onClick={() => void save(true)} className="font-medium underline">
            {t('editor.conflict.overwrite')}
          </button>
        </div>
      ) : null}

      {/* Le rendu remplace l'éditeur au lieu de s'afficher à côté : le panneau fait
          quelques centaines de pixels de large, deux colonnes n'y tiennent pas. C'est
          `draft` et non le contenu chargé qui est rendu, pour relire ce qu'on vient
          d'écrire sans avoir à enregistrer d'abord. */}
      {isMarkdown && view === 'preview' ? (
        <div className="min-h-0 min-w-0 flex-1 overflow-auto px-4 py-3">
          <Markdown text={draft.current} />
        </div>
      ) : (
        <div className="min-h-0 min-w-0 flex-1">
          <CodeEditor
            initial={draft.current}
            path={file.path}
            onChange={(value) => {
              draft.current = value
              markDirty(path, value !== file.content)
            }}
            onSave={() => void save(false)}
          />
        </div>
      )}

      <div className="flex shrink-0 items-center gap-2 border-t border-line px-2.5 py-1 text-[0.6875rem] text-ink-faint">
        <span className="min-w-0 flex-1 truncate" title={path}>
          {path}
        </span>
        {isMarkdown ? (
          <button
            type="button"
            onClick={() => setMarkdownView(view === 'preview' ? 'source' : 'preview')}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:text-ink"
          >
            {view === 'preview' ? <Code2 size={11} /> : <Eye size={11} />}
            {view === 'preview' ? t('editor.markdown.source') : t('editor.markdown.preview')}
          </button>
        ) : null}
        {/* Rien à enregistrer depuis le rendu : il n'a pas de curseur, et le brouillon
            attend intact le retour à la source. */}
        {isMarkdown && view === 'preview' ? null : (
          <button
            type="button"
            onClick={() => void save(false)}
            disabled={saving}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:text-ink disabled:opacity-45"
          >
            {saving ? <Loader size={11} className="animate-spin" /> : <Save size={11} />}
            {t('editor.save')}
          </button>
        )}
      </div>
    </div>
  )
}
