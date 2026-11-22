import * as Dialog from '@radix-ui/react-dialog'
import { useMutation } from '@tanstack/react-query'
import {
  ChevronRight,
  CornerLeftUp,
  Eye,
  EyeOff,
  Folder,
  FolderGit2,
  FolderPlus,
  Home,
  Lock,
  X,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { ApiRequestError } from '../lib/api'
import { breadcrumbSegments, readDirectory, useCreateDirectory, useDirectoryListing } from '../lib/fs'
import { useTranslate } from '../lib/i18n'
import { Badge, Banner, Button, IconButton, cx } from './ui'

interface DirectoryPickerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Initially open directory; empty or invalid falls back to home. */
  initialPath: string
  onConfirm: (path: string) => void
}

export function DirectoryPicker({
  open,
  onOpenChange,
  initialPath,
  onConfirm,
}: DirectoryPickerProps) {
  const t = useTranslate()
  // null lets the server choose the home directory.
  const [path, setPath] = useState<string | null>(initialPath || null)
  const [showHidden, setShowHidden] = useState(false)
  const [creating, setCreating] = useState(false)
  const listing = useDirectoryListing(open ? path : null, showHidden)
  const createDir = useCreateDirectory()
  const [typedPath, setTypedPath] = useState<string | null>(null)
  const checkPath = useMutation({
    mutationFn: async (value: string) => {
      const posix = value.startsWith('/')
      const windows = /^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(value)
      if (!posix && !windows) throw new Error(t('directoryPicker.path.absolute'))
      const folder = await readDirectory(value, showHidden)
      // The browser may be on a different OS. Only the server knows which paths are absolute.
      if (!(folder.path.startsWith('/') ? posix : windows)) throw new Error(t('directoryPicker.path.absolute'))
      return folder.path
    },
  })
  const resetCheck = checkPath.reset
  const navigate = (next: string | null) => {
    resetCheck()
    setTypedPath(null)
    setPath(next)
  }

  // Reopening starts at the form's current path rather than the last visited directory.
  useEffect(() => {
    resetCheck()
    setTypedPath(null)
    if (open) setPath(initialPath || null)
  }, [open, initialPath, resetCheck])

  // Directory navigation abandons ongoing creation because its parent changed.
  useEffect(() => {
    setCreating(false)
  }, [path])

  const current = listing.data
  const error =
    createDir.error instanceof ApiRequestError
      ? createDir.error.message
      : createDir.error
        ? t('filetree.error.unreadable')
        : listing.error instanceof ApiRequestError
          ? listing.error.message
          : listing.error
            ? t('filetree.error.unreadable')
            : null

  const canChoose = !checkPath.isPending && (typedPath !== null ? Boolean(typedPath) : Boolean(current && !listing.isPlaceholderData && !listing.isError))
  const choose = () => {
    if (!canChoose) return
    const confirm = (directory: string) => {
      onConfirm(directory)
      onOpenChange(false)
    }
    if (typedPath !== null) checkPath.mutate(typedPath, { onSuccess: confirm })
    else if (current) confirm(current.path)
  }

  const handleCreateFolder = (name: string) => {
    if (!current) return
    setCreating(false)
    createDir.mutate(
      { path: current.path, name },
      { onSuccess: (entry) => navigate(entry.path) },
    )
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
        <Dialog.Content
          className={cx(
            'fixed z-50 flex flex-col overflow-hidden surface border-line shadow-pop',
            // Fullscreen sheet on mobile, centered window on desktop.
            'inset-0 border-0',
            'sm:inset-auto sm:top-1/2 sm:left-1/2 sm:h-[min(32rem,85dvh)] sm:w-[min(34rem,92vw)]',
            'sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg sm:border',
          )}
        >
          <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2 pt-safe">
            <Dialog.Title className="flex-1 text-sm font-semibold">
              {t('directoryPicker.title')}
            </Dialog.Title>
            <IconButton
              label={t('directoryPicker.newFolder')}
              disabled={!current}
              onClick={() => setCreating(true)}
            >
              <FolderPlus size={18} />
            </IconButton>
            <IconButton
              label={showHidden ? t('directoryPicker.hidden.hide') : t('directoryPicker.hidden.show')}
              onClick={() => setShowHidden((value) => !value)}
            >
              {showHidden ? <Eye size={18} /> : <EyeOff size={18} />}
            </IconButton>
            <Dialog.Close asChild>
              <IconButton label={t('common.close')}>
                <X size={18} />
              </IconButton>
            </Dialog.Close>
          </header>

          <nav className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-3 py-2">
            {current?.roots.map((root) => (
              <button
                key={root.path}
                type="button"
                onClick={() => navigate(root.path)}
                className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs text-ink-soft hover:bg-surface-high hover:text-ink"
              >
                {root.label === 'Accueil' ? <Home size={12} /> : null}
                {root.label}
              </button>
            ))}
            <span className="mx-1 h-4 w-px shrink-0 bg-line" aria-hidden />
            {current
              ? breadcrumbSegments(current.path).map((segment) => (
                  <button
                    key={segment.path}
                    type="button"
                    onClick={() => navigate(segment.path)}
                    className="shrink-0 rounded-md px-1.5 py-1 font-mono text-xs text-ink-soft hover:bg-surface-high hover:text-ink"
                  >
                    {segment.label}
                  </button>
                ))
              : null}
          </nav>

          <div className="min-h-0 flex-1 overflow-y-auto p-2">
            {error ? (
              <div className="p-2">
                <Banner>{error}</Banner>
              </div>
            ) : null}

            {creating ? (
              <NewFolderInput onCommit={handleCreateFolder} onCancel={() => setCreating(false)} />
            ) : null}

            {current?.parent ? (
              <Row
                icon={<CornerLeftUp size={16} />}
                label=".."
                onClick={() => navigate(current.parent)}
              />
            ) : null}

            {current?.entries.map((entry) => (
              <Row
                key={entry.path}
                icon={
                  entry.isGitRepo ? (
                    <FolderGit2 size={16} className="text-accent" />
                  ) : (
                    <Folder size={16} />
                  )
                }
                label={entry.name}
                disabled={!entry.readable}
                trailing={
                  entry.readable ? (
                    <ChevronRight size={15} className="text-ink-faint" />
                  ) : (
                    <Lock size={13} className="text-ink-faint" />
                  )
                }
                onClick={() => navigate(entry.path)}
              />
            ))}

            {current && current.entries.length === 0 && !error ? (
              <p className="px-3 py-6 text-center text-sm text-ink-faint">
                {showHidden ? t('directoryPicker.empty.all') : t('directoryPicker.empty.visible')}
              </p>
            ) : null}

            {current?.truncated ? (
              <p className="px-3 py-2 text-center text-xs text-ink-faint">
                {t('directoryPicker.truncated')}
              </p>
            ) : null}
          </div>

          <footer className="flex shrink-0 flex-col gap-2 border-t border-line px-3 py-3 pb-safe">
            <div className="flex items-center gap-2">
              <input
                aria-label={t('directoryPicker.path')}
                placeholder={t('directoryPicker.path')}
                value={typedPath ?? (listing.isPlaceholderData ? path : current?.path ?? path) ?? ''}
                onChange={event => { resetCheck(); setTypedPath(event.target.value) }}
                onKeyDown={event => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    event.preventDefault()
                    choose()
                  }
                }}
                autoCapitalize="none" autoComplete="off" spellCheck={false}
                className="min-h-9 min-w-0 flex-1 rounded-md border border-line bg-sunken px-2 font-mono text-sm text-ink focus:border-accent focus:outline-none"
              />
              {current?.isGitRepo && typedPath === null ? (
                <Badge tone="accent" icon={<FolderGit2 size={11} />}>
                  {t('directoryPicker.gitRepo')}
                </Badge>
              ) : null}
            </div>
            {checkPath.error ? <p role="alert" className="text-xs text-critical">{checkPath.error.message}</p> : null}
            <Button disabled={!canChoose} onClick={choose}>
              {t('directoryPicker.confirm')}
            </Button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Row({
  icon,
  label,
  trailing,
  disabled,
  onClick,
}: {
  icon: React.ReactNode
  label: string
  trailing?: React.ReactNode
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={cx(
        'tap-target flex w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm',
        'transition-colors',
        disabled
          ? 'cursor-not-allowed text-ink-faint'
          : 'text-ink-soft hover:bg-surface-high hover:text-ink',
      )}
    >
      <span className="shrink-0 text-ink-faint">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {trailing ? <span className="shrink-0">{trailing}</span> : null}
    </button>
  )
}

function NewFolderInput({
  onCommit,
  onCancel,
}: {
  onCommit: (name: string) => void
  onCancel: () => void
}) {
  const t = useTranslate()
  const [value, setValue] = useState('')

  return (
    <div className="tap-target flex w-full items-center gap-2.5 rounded-md px-2.5">
      <span className="shrink-0 text-ink-faint">
        <Folder size={16} />
      </span>
      <input
        autoFocus
        aria-label={t('directoryPicker.newFolder')}
        placeholder={t('directoryPicker.newFolder.placeholder')}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            const name = value.trim()
            if (name) onCommit(name)
          }
          if (event.key === 'Escape') onCancel()
        }}
        onBlur={() => {
          const name = value.trim()
          if (name) onCommit(name)
          else onCancel()
        }}
        className="h-7 min-w-0 flex-1 rounded border border-accent bg-sunken px-1.5 text-sm text-ink outline-none"
      />
    </div>
  )
}
