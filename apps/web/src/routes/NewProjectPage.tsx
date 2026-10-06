import {
  FolderOpen,
  FolderPlus,
  GitBranch,
  Globe,
  Lock,
} from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { slugifyProjectName } from '@sillage/protocol'
import { ApiRequestError } from '../lib/api'
import { useCreateProject } from '../lib/projects'
import { useUserSettings } from '../lib/user-settings'
import { CloneForm } from '../components/CloneForm'
import { PathField } from '../components/PathField'
import {
  InstructionsModeSelect,
  instructionsModeField,
  type InstructionsModeChoice,
} from '../components/instructions/Instructions'
import { useTranslate } from '../lib/i18n'
import {
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  ChoiceList,
  Field,
  Select,
  type Choice,
  type SelectOption,
} from '../components/ui'

type CreateMode = 'new' | 'existing' | 'clone'
type Visibility = 'private' | 'shared'

function useVisibilityOptions(): SelectOption<Visibility>[] {
  const t = useTranslate()
  return [
    {
      value: 'private',
      label: t('project.visibility.private'),
      icon: <Lock size={15} />,
      hint: t('project.visibility.private.hint'),
    },
    {
      value: 'shared',
      label: t('project.visibility.shared'),
      icon: <Globe size={15} />,
      hint: t('project.visibility.shared.hint'),
    },
  ]
}

export function NewProjectPage() {
  const t = useTranslate()
  // Le cas courant en premier : un projet qui démarre n'a qu'un nom à donner.
  const [mode, setMode] = useState<CreateMode>('new')

  const MODE_OPTIONS: Choice<CreateMode>[] = [
    {
      value: 'new',
      label: t('projects.create.mode.new'),
      hint: t('projects.create.mode.new.hint'),
      icon: <FolderPlus size={15} />,
    },
    {
      value: 'existing',
      label: t('projects.create.mode.existing'),
      hint: t('projects.create.mode.existing.hint'),
      icon: <FolderOpen size={15} />,
    },
    {
      value: 'clone',
      label: t('projects.create.mode.clone'),
      hint: t('projects.create.mode.clone.hint'),
      icon: <GitBranch size={15} />,
    },
  ]

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4 md:p-8">
      <h1 className="text-lg font-semibold tracking-tight">{t('projects.create.title')}</h1>

      <Card>
        <CardHeader
          title={t('projects.create.mode')}
          description={t('projects.create.description')}
          icon={<FolderOpen size={16} />}
        />
        <CardBody className="flex flex-col gap-4">
          <ChoiceList
            label={t('projects.create.mode')}
            value={mode}
            options={MODE_OPTIONS}
            onChange={setMode}
          />

          {mode === 'clone' ? <CloneForm /> : null}
          {mode === 'new' ? <NewFolderForm /> : null}
          {mode === 'existing' ? <ExistingFolderForm /> : null}
        </CardBody>
      </Card>
    </div>
  )
}

/**
 * Le raccourci : un nom, et le dossier suit.
 *
 * Le nom de dossier est déduit du nom du projet tant qu'on ne l'a pas repris à la main,
 * et le dossier parent est celui de la dernière création. Dans le cas courant, il n'y a
 * donc qu'un champ à remplir.
 */
function NewFolderForm() {
  const t = useTranslate()
  const createProject = useCreateProject()
  const navigate = useNavigate()
  const { data: settings } = useUserSettings()
  const visibilityOptions = useVisibilityOptions()

  const [name, setName] = useState('')
  const [directory, setDirectory] = useState('')
  const [parentDir, setParentDir] = useState('')
  const [visibility, setVisibility] = useState<Visibility>('private')
  const [instructionsMode, setInstructionsMode] = useState<InstructionsModeChoice>('auto')

  // Les réglages arrivent après le premier rendu : le dossier mémorisé ne s'impose que
  // sur un champ encore vide, jamais par-dessus une saisie.
  useEffect(() => {
    if (settings?.projectsDir) setParentDir((current) => current || settings.projectsDir!)
  }, [settings?.projectsDir])

  const applyName = (next: string) => {
    if (directory === slugifyProjectName(name)) setDirectory(slugifyProjectName(next))
    setName(next)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    createProject.mutate(
      {
        name: name.trim(),
        parentDir,
        directory: directory.trim(),
        visibility,
        ...instructionsModeField(instructionsMode),
      },
      {
        onSuccess: (project) => navigate(`/p/${project.id}/c/new`),
      },
    )
  }

  const error =
    createProject.error instanceof ApiRequestError ? createProject.error.message : null
  const preview =
    parentDir && directory ? `${parentDir.replace(/\/+$/, '')}/${directory}` : null

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Field
        label={t('projects.create.name')}
        value={name}
        onChange={(event) => applyName(event.target.value)}
        placeholder={t('projects.create.name.placeholder')}
        required
      />
      <PathField
        label={t('projects.create.parentDir')}
        value={parentDir}
        onChange={setParentDir}
        placeholder={t('projects.create.parentDir.placeholder')}
        hint={t('projects.create.parentDir.hint')}
        required
      />
      <Field
        label={t('projects.create.directory')}
        value={directory}
        onChange={(event) => setDirectory(event.target.value)}
        hint={preview ? t('projects.create.preview', { path: preview }) : t('projects.create.directory.hint')}
        autoCapitalize="none"
        autoCorrect="off"
        required
      />
      <Select
        label={t('project.settings.visibility')}
        value={visibility}
        onChange={setVisibility}
        options={visibilityOptions}
      />
      <InstructionsModeSelect value={instructionsMode} onChange={setInstructionsMode} />
      {error ? <Banner>{error}</Banner> : null}
      <Button type="submit" disabled={createProject.isPending} className="self-start">
        {createProject.isPending ? t('projects.create.pending') : t('projects.create.submit')}
      </Button>
    </form>
  )
}

/** Un dossier déjà présent, n'importe où sur la machine : rien n'est créé. */
function ExistingFolderForm() {
  const t = useTranslate()
  const createProject = useCreateProject()
  const navigate = useNavigate()
  const visibilityOptions = useVisibilityOptions()

  const [name, setName] = useState('')
  const [workspacePath, setWorkspacePath] = useState('')
  const [visibility, setVisibility] = useState<Visibility>('private')
  const [instructionsMode, setInstructionsMode] = useState<InstructionsModeChoice>('auto')

  const submit = (event: FormEvent) => {
    event.preventDefault()
    createProject.mutate(
      { name: name.trim(), workspacePath, visibility, ...instructionsModeField(instructionsMode) },
      {
        onSuccess: (project) => navigate(`/p/${project.id}/c/new`),
      },
    )
  }

  const error =
    createProject.error instanceof ApiRequestError ? createProject.error.message : null

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <Field
        label={t('projects.create.name')}
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder={t('projects.create.name.placeholder')}
        required
      />
      <PathField
        label={t('projects.create.workspacePath')}
        value={workspacePath}
        onChange={setWorkspacePath}
        placeholder={t('projects.create.workspacePath.placeholder')}
        hint={t('projects.create.workspacePath.hint')}
        required
      />
      <Select
        label={t('project.settings.visibility')}
        value={visibility}
        onChange={setVisibility}
        options={visibilityOptions}
      />
      <InstructionsModeSelect value={instructionsMode} onChange={setInstructionsMode} />
      {error ? <Banner>{error}</Banner> : null}
      <Button type="submit" disabled={createProject.isPending} className="self-start">
        {createProject.isPending ? t('projects.create.pending') : t('projects.create.submit')}
      </Button>
    </form>
  )
}
