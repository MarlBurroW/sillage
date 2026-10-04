import {
  ArrowLeft,
  BookOpen,
  Copy,
  Download,
  FolderInput,
  MoreHorizontal,
  Power,
  Save,
  ScrollText,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  skillDescriptionSchema,
  skillNameSchema,
  type LibrarySkillDetailDto,
  type SkillCompatNote,
} from '@sillage/protocol'
import { CodeEditor } from '../components/panel/CodeEditor'
import { useSkillPermissions, type SkillDestination } from '../components/skills/permissions'
import { DescriptionField, NameField, SkillDialog } from '../components/skills/SkillDialog'
import { SkillFiles } from '../components/skills/SkillFiles'
import { SkillBadges } from '../components/skills/SkillList'
import { UpdateDialog } from '../components/skills/UpdateDialog'
import { useEditorRevision } from '../components/skills/use-editor-revision'
import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  IconButton,
  Menu,
  MenuItem,
  MenuSeparator,
  Select,
} from '../components/ui'
import { ApiRequestError } from '../lib/api'
import { useTranslate } from '../lib/i18n'
import {
  exportUrl,
  useDeleteLibrarySkill,
  useDuplicateLibrarySkill,
  useLibrarySkill,
  useUpdateLibrarySkill,
} from '../lib/skill-library'
import { shortCommit } from '../lib/skill-sources'

const errorOf = (error: unknown): string | null => (error instanceof ApiRequestError ? error.message : null)

/**
 * Un skill de la bibliothèque, en pleine largeur : les instructions et les fichiers
 * annexes demandent plus de place que la colonne des réglages.
 *
 * Lisible par tous ceux qui voient la portée, modifiable par qui peut y écrire : le
 * global par un administrateur, un projet par son propriétaire.
 */
export function SkillEditorPage() {
  const t = useTranslate()
  const { skillId = '' } = useParams()
  const { data: skill, isLoading, error } = useLibrarySkill(skillId)
  const permissions = useSkillPermissions()

  if (isLoading) return <p className="p-8 text-sm text-ink-faint">{t('skills.editor.loading')}</p>
  if (error || !skill) {
    return (
      <EmptyState
        icon={<BookOpen size={22} />}
        title={t('skills.editor.notFound')}
        action={<Link to="/settings/skills" className="text-sm text-accent hover:underline">{t('skills.editor.backGlobal')}</Link>}
      />
    )
  }
  // Remonté à chaque skill : les brouillons d'un skill ne doivent pas suivre dans le suivant.
  return <SkillEditor key={skill.id} skill={skill} permissions={permissions} />
}

interface Draft {
  name: string
  description: string
  body: string
}

function SkillEditor({
  skill,
  permissions,
}: {
  skill: LibrarySkillDetailDto
  permissions: ReturnType<typeof useSkillPermissions>
}) {
  const t = useTranslate()
  const navigate = useNavigate()
  const update = useUpdateLibrarySkill()
  const remove = useDeleteLibrarySkill()
  const canWrite = permissions.canWrite(skill.scope, skill.projectId)
  /** Les champs touchés seulement : ce qui n'a pas été modifié suit l'enregistrement. */
  const [draft, setDraft] = useState<Partial<Draft>>({})
  const editor = useEditorRevision(skill.body, draft.body !== undefined)
  const [dialog, setDialog] = useState<'duplicate' | 'move' | 'delete' | 'update' | null>(null)

  const current: Draft = {
    name: draft.name ?? skill.name,
    description: draft.description ?? skill.description,
    body: draft.body ?? skill.body,
  }
  const changes: Partial<Draft> = {
    ...(current.name !== skill.name ? { name: current.name } : {}),
    ...(current.description.trim() !== skill.description ? { description: current.description.trim() } : {}),
    ...(current.body !== skill.body ? { body: current.body } : {}),
  }
  const dirty = Object.keys(changes).length > 0
  const valid = skillNameSchema.safeParse(current.name).success && skillDescriptionSchema.safeParse(current.description).success

  const save = () => {
    if (!canWrite || !dirty || !valid || update.isPending) return
    update.mutate({ id: skill.id, ...changes }, { onSuccess: () => setDraft({}) })
  }

  /** Abandonne les brouillons ; l'éditeur, qui ne lit son texte qu'au montage, repart. */
  const discard = () => {
    setDraft({})
    editor.reset()
  }

  const back = skill.scope === 'global' ? '/settings/skills' : `/p/${skill.projectId}`
  const backLabel =
    skill.scope === 'global'
      ? t('skills.editor.backGlobal')
      : t('skills.editor.backProject', { name: permissions.projectName(skill.projectId) ?? '' })
  const elsewhere = permissions.destinations.filter(
    (destination) => destination.scope !== skill.scope || destination.projectId !== skill.projectId,
  )

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 md:p-8">
      <Link to={back} className="flex items-center gap-1 self-start text-sm text-ink-faint hover:text-ink">
        <ArrowLeft size={14} />
        {backLabel}
      </Link>

      {/* La largeur minimale du titre renvoie les boutons à la ligne au doigt, plutôt
          que d'écraser la phrase d'invocation dans une colonne de trois mots. */}
      <header className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-64 flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-mono text-xl font-semibold tracking-tight">{skill.name}</h1>
            <SkillBadges skill={skill} showScope />
          </div>
          <p className="text-sm text-ink-faint">
            {t('skills.editor.invocation', { name: skill.name })}
          </p>
          {skill.origin ? (
            <p className="font-mono text-xs text-ink-faint">
              {t('skills.editor.origin', {
                source: skill.origin.sourceName ?? t('skills.editor.origin.removed'),
                path: skill.origin.path || '/',
                commit: shortCommit(skill.origin.commit),
              })}
            </p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {canWrite ? (
            <>
              {dirty ? (
                <Button variant="ghost" size="sm" onClick={discard}>
                  {t('skills.editor.discard')}
                </Button>
              ) : null}
              <Button size="sm" icon={<Save size={15} />} disabled={!dirty || !valid || update.isPending} onClick={save}>
                {update.isPending ? t('skills.editor.saving') : t('skills.editor.save')}
              </Button>
            </>
          ) : null}
          <Menu trigger={<IconButton label={t('skills.editor.actions')}><MoreHorizontal size={18} /></IconButton>}>
            {canWrite ? (
              <MenuItem icon={<Power size={15} />} onSelect={() => update.mutate({ id: skill.id, enabled: !skill.enabled })}>
                {t(skill.enabled ? 'skills.action.disable' : 'skills.action.enable')}
              </MenuItem>
            ) : null}
            <MenuItem icon={<Download size={15} />} onSelect={() => { window.location.href = exportUrl(skill.id) }}>
              {t('skills.action.export')}
            </MenuItem>
            <MenuItem icon={<Copy size={15} />} disabled={permissions.destinations.length === 0} onSelect={() => setDialog('duplicate')}>
              {t('skills.action.duplicate')}
            </MenuItem>
            {canWrite ? (
              <>
                <MenuItem icon={<FolderInput size={15} />} disabled={elsewhere.length === 0 || dirty} onSelect={() => setDialog('move')}>
                  {t('skills.action.move')}
                </MenuItem>
                <MenuSeparator />
                <MenuItem icon={<Trash2 size={15} />} tone="critical" onSelect={() => setDialog('delete')}>
                  {t('skills.action.delete')}
                </MenuItem>
              </>
            ) : null}
          </Menu>
        </div>
      </header>

      {skill.updateAvailable ? (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-accent/40 bg-accent-wash px-3 py-2 text-sm">
          <span className="min-w-0 flex-1">{t('skills.update.available', { source: skill.origin?.sourceName ?? '' })}</span>
          <Button size="sm" variant="secondary" onClick={() => setDialog('update')}>
            {t('skills.update.review')}
          </Button>
        </div>
      ) : null}
      {skill.problem ? <Banner>{t(`skills.problem.${skill.problem}.detail`)}</Banner> : null}
      {!skill.enabled ? <Banner tone="info">{t('skills.editor.disabled')}</Banner> : null}
      {!canWrite ? <Banner tone="info">{t('skills.editor.readonly')}</Banner> : null}
      {errorOf(update.error) ? <Banner>{errorOf(update.error)}</Banner> : null}

      <Card>
        <CardHeader title={t('skills.editor.identity')} description={t('skills.editor.identity.description')} icon={<BookOpen size={16} />} />
        <CardBody className="flex flex-col gap-4">
          <NameField value={current.name} disabled={!canWrite} onChange={(name) => setDraft({ ...draft, name })} />
          <DescriptionField
            label={t('skills.field.description')}
            hint={t('skills.field.description.hint')}
            value={current.description}
            disabled={!canWrite}
            onChange={(description) => setDraft({ ...draft, description })}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={t('skills.editor.body')} description={t('skills.editor.body.description')} icon={<ScrollText size={16} />} />
        <div className="h-[28rem] border-t border-line">
          <CodeEditor
            key={editor.revision}
            initial={skill.body}
            path="SKILL.md"
            onChange={(body) => {
              editor.track(body)
              setDraft((previous) => ({ ...previous, body }))
            }}
            onSave={save}
            sessionKey={`skill:${skill.id}:SKILL.md`}
            revision={editor.revision}
            onPosition={() => {}}
            readOnly={!canWrite}
          />
        </div>
      </Card>

      {skill.compat.length > 0 ? <CompatCard notes={skill.compat} /> : null}

      <SkillFiles skill={skill} canWrite={canWrite} />

      <CopyDialog
        open={dialog === 'duplicate'}
        onClose={() => setDialog(null)}
        skill={skill}
        destinations={permissions.destinations}
      />
      <MoveDialog
        open={dialog === 'move'}
        onClose={() => setDialog(null)}
        skill={skill}
        destinations={elsewhere}
      />
      <UpdateDialog open={dialog === 'update'} onClose={() => setDialog(null)} skill={skill} canWrite={canWrite} />
      <ConfirmDialog
        open={dialog === 'delete'}
        onOpenChange={(open) => { if (!open) setDialog(null) }}
        title={t('skills.delete.title', { name: skill.name })}
        confirmLabel={t('skills.delete.confirm')}
        tone="critical"
        busy={remove.isPending}
        onConfirm={() => remove.mutate(skill.id, { onSuccess: () => navigate(back) })}
      >
        {t('skills.delete.body')}
      </ConfirmDialog>
    </div>
  )
}

/** Ce que le skill fera différemment chez l'un des deux CLI. */
function CompatCard({ notes }: { notes: SkillCompatNote[] }) {
  const t = useTranslate()
  return (
    <Card>
      <CardHeader title={t('skills.compat.title')} description={t('skills.compat.description')} icon={<TriangleAlert size={16} />} />
      <CardBody className="flex flex-col gap-2">
        {notes.map((note) => (
          <Banner key={`${note.code}:${note.field ?? ''}`} tone={note.code === 'runs_scripts' ? 'caution' : 'info'}>
            {t(`skills.compat.${note.code}`, { field: note.field ?? '' })}
          </Banner>
        ))}
      </CardBody>
    </Card>
  )
}

function DestinationSelect({
  destinations,
  value,
  onChange,
}: {
  destinations: SkillDestination[]
  value: string
  onChange: (value: string) => void
}) {
  const t = useTranslate()
  return (
    <Select
      label={t('skills.field.destination')}
      value={value}
      onChange={onChange}
      options={destinations.map((destination) => ({ value: destination.value, label: destination.label }))}
    />
  )
}

function CopyDialog({
  open,
  onClose,
  skill,
  destinations,
}: {
  open: boolean
  onClose: () => void
  skill: LibrarySkillDetailDto
  destinations: SkillDestination[]
}) {
  const t = useTranslate()
  const navigate = useNavigate()
  const duplicate = useDuplicateLibrarySkill()
  const [name, setName] = useState(`${skill.name}-copy`.slice(0, 64))
  const [target, setTarget] = useState(destinations[0]?.value ?? '')
  const destination = destinations.find((entry) => entry.value === target)

  return (
    <SkillDialog
      open={open}
      onClose={() => { duplicate.reset(); onClose() }}
      title={t('skills.duplicate.title', { name: skill.name })}
      submitLabel={duplicate.isPending ? t('skills.duplicate.pending') : t('skills.duplicate.submit')}
      busy={duplicate.isPending}
      canSubmit={destination !== undefined && skillNameSchema.safeParse(name).success}
      onSubmit={() =>
        destination &&
        duplicate.mutate(
          { id: skill.id, name, scope: destination.scope, projectId: destination.projectId },
          { onSuccess: (created) => { onClose(); navigate(`/skills/${created.id}`) } },
        )
      }
    >
      <NameField value={name} onChange={setName} />
      <DestinationSelect destinations={destinations} value={target} onChange={setTarget} />
      {errorOf(duplicate.error) ? <Banner>{errorOf(duplicate.error)}</Banner> : null}
    </SkillDialog>
  )
}

/** Changer de portée change aussi qui le voit : toutes les conversations, ou un projet. */
function MoveDialog({
  open,
  onClose,
  skill,
  destinations,
}: {
  open: boolean
  onClose: () => void
  skill: LibrarySkillDetailDto
  destinations: SkillDestination[]
}) {
  const t = useTranslate()
  const update = useUpdateLibrarySkill()
  const [target, setTarget] = useState(destinations[0]?.value ?? '')
  const destination = destinations.find((entry) => entry.value === target)

  return (
    <SkillDialog
      open={open}
      onClose={() => { update.reset(); onClose() }}
      title={t('skills.move.title', { name: skill.name })}
      submitLabel={update.isPending ? t('skills.move.pending') : t('skills.move.submit')}
      busy={update.isPending}
      canSubmit={destination !== undefined}
      onSubmit={() =>
        destination &&
        update.mutate(
          { id: skill.id, scope: destination.scope, projectId: destination.projectId },
          { onSuccess: onClose },
        )
      }
    >
      <p className="text-sm text-ink-faint">{t('skills.move.description')}</p>
      <DestinationSelect destinations={destinations} value={target} onChange={setTarget} />
      {errorOf(update.error) ? <Banner>{errorOf(update.error)}</Banner> : null}
    </SkillDialog>
  )
}
