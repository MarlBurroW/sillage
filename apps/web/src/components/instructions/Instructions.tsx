import * as Dialog from '@radix-ui/react-dialog'
import { Eye, FileText, Pencil, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  MAX_INSTRUCTIONS_CHARS,
  MAX_REPO_INSTRUCTIONS_CHARS,
  type InstructionsAuthorDto,
  type InstructionsMode,
  type ProjectInstructionsDto,
  type RepoInstructionFile,
} from '@sillage/protocol'
import { ApiRequestError } from '../../lib/api'
import { locale, useTranslate } from '../../lib/i18n'
import {
  mergedForImport,
  useGlobalInstructions,
  useProjectInstructions,
  useSaveGlobalInstructions,
  useUpdateProjectInstructions,
  useWriteRepoInstructions,
} from '../../lib/instructions'
import { Markdown } from '../chat/Markdown'
import { Banner, Button, ChoiceList, ConfirmDialog, IconButton, Select, cx, type Choice } from '../ui'

/**
 * Éditeur d'une partie de consignes : du markdown, un aperçu, un bouton d'enregistrement.
 *
 * Le brouillon suit la version serveur tant qu'on n'y a pas touché : une consigne qu'un
 * agent écrit pendant que la page est ouverte apparaît, sans écraser une saisie en cours.
 */
export function MarkdownEditor({
  value,
  canEdit,
  maxLength,
  placeholder,
  saving,
  error,
  footer,
  onSave,
}: {
  value: string
  canEdit: boolean
  maxLength: number
  placeholder: string
  saving: boolean
  error: unknown
  footer?: ReactNode
  onSave: (content: string) => void
}) {
  const t = useTranslate()
  const [draft, setDraft] = useState<string | null>(null)
  const [preview, setPreview] = useState(!canEdit)
  const text = draft ?? value
  const dirty = draft !== null && draft !== value

  // Enregistré : le brouillon redevient la version serveur.
  useEffect(() => {
    if (draft !== null && draft === value) setDraft(null)
  }, [draft, value])

  return (
    <div className="flex flex-col gap-2">
      {canEdit ? (
        <div className="flex gap-1 self-end rounded-lg bg-sunken p-1">
          {[false, true].map((on) => (
            <button
              key={String(on)}
              type="button"
              aria-pressed={preview === on}
              onClick={() => setPreview(on)}
              className={cx(
                'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs',
                preview === on ? 'surface text-ink shadow-sm' : 'text-ink-faint hover:text-ink',
              )}
            >
              {on ? <Eye size={13} /> : <Pencil size={13} />}
              {t(on ? 'board.editor.preview' : 'board.editor.write')}
            </button>
          ))}
        </div>
      ) : null}

      {preview ? (
        <div className="min-h-40 rounded-md border border-line px-4 py-3 text-sm">
          {text.trim() ? (
            <Markdown text={text} />
          ) : (
            <p className="text-ink-faint">{t('instructions.empty')}</p>
          )}
        </div>
      ) : (
        <textarea
          value={text}
          rows={14}
          maxLength={maxLength}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          className="min-h-60 w-full resize-y rounded-md border border-line bg-sunken px-3 py-2 font-mono text-[0.8125rem] leading-relaxed text-ink outline-none placeholder:font-sans placeholder:text-ink-faint hover:border-line-strong focus:border-accent"
        />
      )}

      {error instanceof ApiRequestError ? <Banner>{error.message}</Banner> : null}

      <div className="flex flex-wrap items-center gap-3">
        {canEdit ? (
          <>
            <Button size="sm" disabled={!dirty || saving} onClick={() => onSave(text)}>
              {t(saving ? 'instructions.saving' : 'instructions.save')}
            </Button>
            {dirty ? (
              <Button size="sm" variant="ghost" disabled={saving} onClick={() => setDraft(null)}>
                {t('dialog.cancel')}
              </Button>
            ) : null}
          </>
        ) : null}
        <span className="text-xs text-ink-faint">
          {t('instructions.count', { count: text.length.toLocaleString(locale()) })}
        </span>
        {footer}
      </div>
    </div>
  )
}

function AuthorLine({ author, updatedAt }: { author: InstructionsAuthorDto | null; updatedAt: number | null }) {
  const t = useTranslate()
  if (!author || updatedAt === null) return null
  const when = new Date(updatedAt).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' })
  return (
    <span className="text-xs text-ink-faint">
      {author.kind === 'user' ? (
        t('instructions.author.user', { name: author.name, when })
      ) : (
        <>
          {t('instructions.author.session', { when })}{' '}
          {author.projectId ? (
            <Link
              to={`/p/${author.projectId}/c/${author.conversationId}`}
              className="text-accent hover:underline"
            >
              {author.title ?? t('instructions.author.session.untitled')}
            </Link>
          ) : (
            author.title ?? t('instructions.author.session.untitled')
          )}
        </>
      )}
    </span>
  )
}

/** La partie globale, commune à tous les projets de l'instance. */
export function GlobalInstructions() {
  const t = useTranslate()
  const { data } = useGlobalInstructions()
  const save = useSaveGlobalInstructions()
  if (!data) return null

  return (
    <div className="flex flex-col gap-3">
      {!data.canEdit ? <Banner tone="info">{t('instructions.global.readonly')}</Banner> : null}
      <MarkdownEditor
        value={data.content}
        canEdit={data.canEdit}
        maxLength={MAX_INSTRUCTIONS_CHARS}
        placeholder={t('instructions.global.placeholder')}
        saving={save.isPending}
        error={save.error}
        onSave={(content) => save.mutate(content)}
        footer={<AuthorLine author={data.author} updatedAt={data.updatedAt} />}
      />
    </div>
  )
}

/**
 * La partie projet : où elle vit, et son contenu selon ce choix.
 *
 * En mode dépôt avec des fichiers déjà là, le passage dans Sillage est proposé ici et
 * nulle part ailleurs : c'est l'endroit où l'on vient relire ses consignes, et rien ne
 * presse un projet qui marche tel qu'il est.
 */
export function ProjectInstructions({ projectId }: { projectId: string }) {
  const t = useTranslate()
  const { data } = useProjectInstructions(projectId)
  const update = useUpdateProjectInstructions(projectId)
  const [migrating, setMigrating] = useState(false)
  if (!data) return null

  const modes: Choice<InstructionsMode>[] = [
    { value: 'sillage', label: t('instructions.mode.sillage'), hint: t('instructions.mode.sillage.hint') },
    { value: 'repo', label: t('instructions.mode.repo'), hint: t('instructions.mode.repo.hint') },
  ]
  const fileNames = data.repoFiles.map((file) => file.path).join(', ')

  return (
    <div className="flex flex-col gap-4">
      {data.canEdit ? (
        <ChoiceList
          label={t('instructions.mode')}
          value={data.mode}
          options={modes}
          onChange={(mode) => update.mutate({ mode })}
        />
      ) : null}

      {data.mode === 'repo' && data.repoFiles.length > 0 && data.canEdit ? (
        <div className="flex flex-col gap-2 rounded-md border border-line bg-sunken px-3 py-2.5 text-sm">
          <p className="text-ink-soft">{t('instructions.migrate.prompt', { files: fileNames })}</p>
          <Button size="sm" variant="secondary" className="self-start" onClick={() => setMigrating(true)}>
            {t('instructions.migrate.action')}
          </Button>
        </div>
      ) : null}

      {data.mode === 'sillage' ? (
        <>
          {data.repoFiles.length > 0 ? (
            <p className="text-xs text-ink-faint">{t('instructions.masked', { files: fileNames })}</p>
          ) : null}
          <MarkdownEditor
            value={data.content}
            canEdit={data.canEdit}
            maxLength={MAX_INSTRUCTIONS_CHARS}
            placeholder={t('instructions.project.placeholder')}
            saving={update.isPending}
            error={update.error}
            onSave={(content) => update.mutate({ content })}
            footer={<AuthorLine author={data.author} updatedAt={data.updatedAt} />}
          />
        </>
      ) : (
        <RepoFileEditor projectId={projectId} data={data} />
      )}

      <ConfirmDialog
        open={migrating}
        onOpenChange={setMigrating}
        title={t('instructions.migrate.title')}
        confirmLabel={t('instructions.migrate.confirm')}
        busy={update.isPending}
        onConfirm={() =>
          update.mutate(
            { mode: 'sillage', content: mergedForImport(data.content, data.repoFiles) },
            { onSuccess: () => setMigrating(false) },
          )
        }
      >
        <p>{t('instructions.migrate.body', { files: fileNames })}</p>
        <p>{t('instructions.migrate.body.keep')}</p>
      </ConfirmDialog>
    </div>
  )
}

/** Le fichier du dépôt, édité sans passer par l'éditeur : `AGENTS.md` par défaut. */
function RepoFileEditor({ projectId, data }: { projectId: string; data: ProjectInstructionsDto }) {
  const t = useTranslate()
  const write = useWriteRepoInstructions(projectId)
  const [selected, setSelected] = useState<RepoInstructionFile | null>(null)
  const path = selected ?? data.repoFiles[0]?.path ?? 'AGENTS.md'
  const file = data.repoFiles.find((candidate) => candidate.path === path)

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <FileText size={14} className="text-ink-faint" />
        {data.repoFiles.length > 1 ? (
          data.repoFiles.map((candidate) => (
            <button
              key={candidate.path}
              type="button"
              aria-pressed={candidate.path === path}
              onClick={() => setSelected(candidate.path)}
              className={cx(
                'rounded-md px-2 py-0.5 font-mono text-xs',
                candidate.path === path ? 'bg-accent-wash text-accent' : 'text-ink-faint hover:text-ink',
              )}
            >
              {candidate.path}
            </button>
          ))
        ) : (
          <span className="font-mono text-xs text-ink-soft">{path}</span>
        )}
        {!file ? <span className="text-xs text-ink-faint">{t('instructions.repo.create')}</span> : null}
      </div>
      <MarkdownEditor
        // Une clé par fichier : changer d'onglet ne doit pas emporter le brouillon de l'autre.
        key={path}
        value={file?.content ?? ''}
        canEdit={data.canEdit}
        maxLength={MAX_REPO_INSTRUCTIONS_CHARS}
        placeholder={t('instructions.project.placeholder')}
        saving={write.isPending}
        error={write.error}
        onSave={(content) => write.mutate({ path, content })}
        footer={<span className="text-xs text-ink-faint">{t('instructions.repo.hint')}</span>}
      />
    </div>
  )
}

/**
 * Les deux parties de SILLAGE.md depuis une conversation, sans la quitter.
 *
 * Le projet d'abord : c'est ce qu'on vient relire en travaillant dessus.
 */
export function InstructionsDialog({
  open,
  onOpenChange,
  projectId,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
}) {
  const t = useTranslate()
  const [tab, setTab] = useState<'project' | 'global'>('project')

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
        <Dialog.Content
          className={cx(
            'surface fixed top-1/2 left-1/2 z-50 w-[min(48rem,94vw)] -translate-x-1/2 -translate-y-1/2',
            'flex max-h-[90dvh] flex-col gap-3 overflow-y-auto rounded-lg border border-line p-4 shadow-pop',
          )}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <Dialog.Title className="text-[0.9375rem] font-semibold tracking-tight">
                {t('instructions.dialog.title')}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-ink-faint">
                {t('instructions.dialog.description')}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <IconButton label={t('instructions.dialog.close')} size="sm">
                <X size={16} />
              </IconButton>
            </Dialog.Close>
          </div>

          <div className="flex gap-1 self-start rounded-lg bg-sunken p-1">
            {(['project', 'global'] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={tab === value}
                onClick={() => setTab(value)}
                className={cx(
                  'rounded-md px-3 py-1.5 text-sm',
                  tab === value ? 'surface text-ink shadow-sm' : 'text-ink-faint hover:text-ink',
                )}
              >
                {t(value === 'project' ? 'instructions.tab.project' : 'instructions.tab.global')}
              </button>
            ))}
          </div>

          {tab === 'project' ? <ProjectInstructions projectId={projectId} /> : <GlobalInstructions />}
          <p className="text-xs text-ink-faint">{t('instructions.dialog.timing')}</p>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/** Le choix proposé à la création ; `auto` laisse le serveur regarder le dossier. */
export type InstructionsModeChoice = InstructionsMode | 'auto'

export function InstructionsModeSelect({
  value,
  onChange,
}: {
  value: InstructionsModeChoice
  onChange: (value: InstructionsModeChoice) => void
}) {
  const t = useTranslate()
  return (
    <Select
      label={t('instructions.mode')}
      value={value}
      onChange={onChange}
      options={[
        { value: 'auto', label: t('instructions.mode.auto'), hint: t('instructions.mode.auto.hint') },
        { value: 'sillage', label: t('instructions.mode.sillage'), hint: t('instructions.mode.sillage.hint') },
        { value: 'repo', label: t('instructions.mode.repo'), hint: t('instructions.mode.repo.hint') },
      ]}
    />
  )
}

/** Ce que l'API attend : rien pour `auto`. */
export function instructionsModeField(choice: InstructionsModeChoice) {
  return choice === 'auto' ? {} : { instructionsMode: choice }
}
