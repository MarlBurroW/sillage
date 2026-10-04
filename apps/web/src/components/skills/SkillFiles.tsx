import { FileCode2, FilePlus2, Save, Trash2, Upload, X } from 'lucide-react'
import { useRef, useState, type ChangeEvent } from 'react'
import { SKILL_MAIN_FILE, skillFilePathSchema, type LibrarySkillDetailDto } from '@sillage/protocol'
import { ApiRequestError } from '../../lib/api'
import { formatBytes } from '../../lib/attachments'
import { useTranslate } from '../../lib/i18n'
import { useDeleteSkillFile, useSkillFile, useUploadSkillFile, useWriteSkillFile } from '../../lib/skill-library'
import { CodeEditor } from '../panel/CodeEditor'
import { Banner, Button, Card, CardBody, CardHeader, ConfirmDialog, Field, IconButton, cx } from '../ui'
import { SkillDialog } from './SkillDialog'

const validPath = (path: string) => skillFilePathSchema.safeParse(path).success && path !== SKILL_MAIN_FILE

const errorOf = (error: unknown): string | null => (error instanceof ApiRequestError ? error.message : null)

/**
 * Les fichiers annexes d'un skill : `scripts/`, `references/`, `assets/`. Le modèle ne
 * les lit qu'à la demande, quand les instructions de `SKILL.md` y renvoient.
 *
 * Un fichier s'ouvre sous la liste, dans le même éditeur que le reste de Sillage. Un
 * binaire ou un fichier trop lourd est seulement décrit.
 */
export function SkillFiles({ skill, canWrite }: { skill: LibrarySkillDetailDto; canWrite: boolean }) {
  const t = useTranslate()
  const files = skill.files.filter((file) => file !== SKILL_MAIN_FILE)
  const [opened, setOpened] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [newPath, setNewPath] = useState('')
  const [pending, setPending] = useState<File | null>(null)
  const [uploadPath, setUploadPath] = useState('')
  const [deleting, setDeleting] = useState<string | null>(null)
  const picker = useRef<HTMLInputElement>(null)
  const write = useWriteSkillFile()
  const upload = useUploadSkillFile()
  const remove = useDeleteSkillFile()

  const picked = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setPending(file)
    setUploadPath(file.name)
  }

  return (
    <Card>
      <CardHeader
        title={t('skills.files.title')}
        description={t('skills.files.description')}
        icon={<FileCode2 size={16} />}
        actions={
          canWrite ? (
            <div className="flex flex-wrap justify-end gap-1">
              <Button size="sm" variant="ghost" icon={<FilePlus2 size={14} />} onClick={() => setCreating(true)}>
                {t('skills.files.new')}
              </Button>
              <Button size="sm" variant="ghost" icon={<Upload size={14} />} onClick={() => picker.current?.click()}>
                {t('skills.files.upload')}
              </Button>
            </div>
          ) : null
        }
      />
      <CardBody className="flex flex-col gap-3">
        <input ref={picker} type="file" hidden onChange={picked} />
        {files.length === 0 ? (
          <p className="text-sm text-ink-faint">{t('skills.files.empty')}</p>
        ) : (
          <ul className="flex flex-col">
            {files.map((file) => (
              <li key={file} className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setOpened(opened === file ? null : file)}
                  className={cx(
                    'min-w-0 flex-1 truncate rounded-md px-2 py-1.5 text-left font-mono text-sm transition-colors',
                    opened === file ? 'bg-accent-wash text-ink' : 'text-ink-soft hover:bg-surface-high hover:text-ink',
                  )}
                >
                  {file}
                </button>
                {canWrite ? (
                  <IconButton label={t('skills.files.delete')} size="sm" onClick={() => setDeleting(file)}>
                    <Trash2 size={14} />
                  </IconButton>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {opened ? (
          <SkillFileEditor key={opened} skillId={skill.id} path={opened} canWrite={canWrite} onClose={() => setOpened(null)} />
        ) : null}
        {errorOf(remove.error) ? <Banner>{errorOf(remove.error)}</Banner> : null}
      </CardBody>

      <SkillDialog
        open={creating}
        onClose={() => { setCreating(false); setNewPath(''); write.reset() }}
        title={t('skills.files.new.title')}
        submitLabel={t('skills.files.new.submit')}
        busy={write.isPending}
        canSubmit={validPath(newPath)}
        onSubmit={() =>
          write.mutate(
            { id: skill.id, path: newPath, content: '' },
            { onSuccess: () => { setCreating(false); setOpened(newPath); setNewPath('') } },
          )
        }
      >
        <PathField value={newPath} onChange={setNewPath} />
        {errorOf(write.error) ? <Banner>{errorOf(write.error)}</Banner> : null}
      </SkillDialog>

      <SkillDialog
        open={pending !== null}
        onClose={() => { setPending(null); upload.reset() }}
        title={t('skills.files.upload.title', { name: pending?.name ?? '' })}
        submitLabel={upload.isPending ? t('skills.files.upload.pending') : t('skills.files.upload.submit')}
        busy={upload.isPending}
        canSubmit={validPath(uploadPath)}
        onSubmit={() =>
          pending &&
          upload.mutate({ id: skill.id, path: uploadPath, file: pending }, { onSuccess: () => setPending(null) })
        }
      >
        <PathField value={uploadPath} onChange={setUploadPath} />
        {errorOf(upload.error) ? <Banner>{errorOf(upload.error)}</Banner> : null}
      </SkillDialog>

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => { if (!open) setDeleting(null) }}
        title={t('skills.files.delete.title', { path: deleting ?? '' })}
        confirmLabel={t('skills.files.delete.confirm')}
        tone="critical"
        busy={remove.isPending}
        onConfirm={() =>
          deleting &&
          remove.mutate(
            { id: skill.id, path: deleting },
            { onSuccess: () => { if (opened === deleting) setOpened(null); setDeleting(null) } },
          )
        }
      >
        {t('skills.files.delete.body')}
      </ConfirmDialog>
    </Card>
  )
}

function PathField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const t = useTranslate()
  return (
    <Field
      label={t('skills.files.path')}
      hint={t('skills.files.path.hint')}
      error={value.length > 0 && !validPath(value) ? t('skills.files.path.invalid') : undefined}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      className="font-mono"
    />
  )
}

function SkillFileEditor({
  skillId,
  path,
  canWrite,
  onClose,
}: {
  skillId: string
  path: string
  canWrite: boolean
  onClose: () => void
}) {
  const t = useTranslate()
  const { data: file, isLoading } = useSkillFile(skillId, path)
  const write = useWriteSkillFile()
  /** Null tant que rien n'a été tapé : le fichier relu fait alors foi. */
  const [draft, setDraft] = useState<string | null>(null)
  const dirty = draft !== null && draft !== file?.content

  const save = () => {
    if (!canWrite || draft === null || !dirty) return
    write.mutate({ id: skillId, path, content: draft }, { onSuccess: () => setDraft(null) })
  }

  return (
    <div className="flex flex-col overflow-hidden rounded-md border border-line">
      <div className="flex items-center gap-2 border-b border-line bg-sunken px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-soft">
          {path}
          {dirty ? <span className="ml-1.5 text-accent">●</span> : null}
        </span>
        {canWrite && file?.content !== null ? (
          <Button size="sm" variant="ghost" icon={<Save size={14} />} disabled={!dirty || write.isPending} onClick={save}>
            {write.isPending ? t('skills.editor.saving') : t('skills.editor.save')}
          </Button>
        ) : null}
        <IconButton label={t('skills.files.close')} size="sm" onClick={onClose}>
          <X size={14} />
        </IconButton>
      </div>
      {isLoading || !file ? (
        <p className="px-3 py-4 text-sm text-ink-faint">{t('skills.files.loading')}</p>
      ) : file.content === null ? (
        <p className="px-3 py-4 text-sm text-ink-faint">{t('skills.files.binary', { size: formatBytes(file.size) })}</p>
      ) : (
        <div className="h-80">
          <CodeEditor
            initial={file.content}
            path={path}
            onChange={setDraft}
            onSave={save}
            sessionKey={`skill:${skillId}:${path}`}
            revision={0}
            onPosition={() => {}}
            readOnly={!canWrite}
          />
        </div>
      )}
      {errorOf(write.error) ? <div className="p-2"><Banner>{errorOf(write.error)}</Banner></div> : null}
    </div>
  )
}
