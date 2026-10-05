import { Brain, ChevronRight, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { MAX_MEMORY_FILE_CHARS, MEMORY_INDEX_FILE, type MemoryFileDto } from '@sillage/protocol'
import { locale, useTranslate } from '../../lib/i18n'
import {
  memoryDescription,
  useDeleteMemoryFile,
  useProjectMemory,
  useWriteMemoryFile,
} from '../../lib/memory'
import { Card, CardBody, CardHeader, ConfirmDialog, IconButton, cx } from '../ui'
import { MarkdownEditor } from './Instructions'

/**
 * La mémoire du projet, sur sa page : ce que les agents ont retenu d'eux-mêmes.
 *
 * Jusqu'ici elle vivait dans un dossier de `~/.claude` que personne n'ouvrait, et Codex
 * ne la voyait pas. La montrer permet de corriger une note fausse avant qu'elle ne
 * trompe la session suivante.
 */
export function ProjectMemory({ projectId }: { projectId: string }) {
  const t = useTranslate()
  const { data } = useProjectMemory(projectId)
  const [open, setOpen] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const remove = useDeleteMemoryFile(projectId)
  const notes = data?.files.filter((file) => file.file !== MEMORY_INDEX_FILE).length ?? 0

  return (
    <Card>
      <CardHeader
        title={t('memory.title')}
        description={t('memory.description')}
        icon={<Brain size={16} />}
      />
      <CardBody className="flex flex-col gap-3">
        {data ? (
          <>
            <p className="text-xs text-ink-faint">
              {t('memory.count', { count: notes })}{' '}
              <span className="font-mono break-all">{data.dir}</span>
            </p>
            {data.importedFrom ? (
              <p className="text-xs text-ink-faint">
                {t('memory.imported', {
                  dir: data.importedFrom.dir,
                  when: new Date(data.importedFrom.at).toLocaleDateString(locale()),
                })}
              </p>
            ) : null}
            {data.files.length === 0 ? (
              <p className="text-sm text-ink-faint">{t('memory.empty')}</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {data.files.map((file) => (
                  <MemoryRow
                    key={file.file}
                    projectId={projectId}
                    file={file}
                    canEdit={data.canEdit}
                    open={open === file.file}
                    onToggle={() => setOpen(open === file.file ? null : file.file)}
                    onDelete={() => setDeleting(file.file)}
                  />
                ))}
              </ul>
            )}
          </>
        ) : null}
      </CardBody>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(next) => (next ? null : setDeleting(null))}
        title={t('memory.delete.title', { file: deleting ?? '' })}
        confirmLabel={t('memory.delete.confirm')}
        tone="critical"
        busy={remove.isPending}
        onConfirm={() =>
          deleting && remove.mutate(deleting, { onSuccess: () => setDeleting(null) })
        }
      >
        <p>{t('memory.delete.body')}</p>
      </ConfirmDialog>
    </Card>
  )
}

function MemoryRow({
  projectId,
  file,
  canEdit,
  open,
  onToggle,
  onDelete,
}: {
  projectId: string
  file: MemoryFileDto
  canEdit: boolean
  open: boolean
  onToggle: () => void
  onDelete: () => void
}) {
  const t = useTranslate()
  const write = useWriteMemoryFile(projectId)
  const isIndex = file.file === MEMORY_INDEX_FILE
  const description = isIndex ? t('memory.index') : memoryDescription(file.content)

  return (
    <li className="rounded-md bg-sunken">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <ChevronRight
            size={14}
            className={cx('shrink-0 text-ink-faint transition-transform', open && 'rotate-90')}
          />
          <span className="shrink-0 font-mono text-sm">{file.file}</span>
          {description ? (
            <span className="min-w-0 flex-1 truncate text-sm text-ink-faint">{description}</span>
          ) : null}
        </button>
        <span className="hidden shrink-0 text-xs text-ink-faint sm:inline">
          {new Date(file.updatedAt).toLocaleDateString(locale())}
        </span>
        {canEdit && !isIndex ? (
          <IconButton label={t('memory.delete.confirm')} size="sm" onClick={onDelete}>
            <Trash2 size={14} />
          </IconButton>
        ) : null}
      </div>
      {open ? (
        <div className="border-t border-line px-3 py-3">
          <MarkdownEditor
            value={file.content}
            canEdit={canEdit}
            maxLength={MAX_MEMORY_FILE_CHARS}
            placeholder=""
            saving={write.isPending}
            error={write.error}
            onSave={(content) => write.mutate({ file: file.file, content })}
          />
        </div>
      ) : null}
    </li>
  )
}
