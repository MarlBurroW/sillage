import {
  FolderOpen,
  FolderPlus,
  GitBranch,
  Globe,
  Lock,
  Sparkles,
} from 'lucide-react'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { slugifyProjectName } from '@sillage/protocol'
import { ApiRequestError } from '../lib/api'
import { useCreateProject, type CreateProjectInput } from '../lib/projects'
import { useCapability } from '../lib/instance'
import { useUserSettings } from '../lib/user-settings'
import { useLooksLikeProject } from '../lib/fs'
import { CloneForm } from '../components/CloneForm'
import { SampleProjectForm } from '../components/SampleProjectForm'
import { NewProjectFolders } from '../components/ProjectFolders'
import { PathField } from '../components/PathField'
import {
  InstructionsModeSelect,
  instructionsModeField,
  useInstructionsModeChoice,
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

const CREATE_MODES = ['new', 'existing', 'clone', 'sample'] as const
type CreateMode = (typeof CREATE_MODES)[number]
const isCreateMode = (value: string | null): value is CreateMode => CREATE_MODES.includes(value as CreateMode)
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
  // Common case first: a new project needs only a name. A link may open another source directly,
  // as the first-run tour does for the sample project.
  const [params] = useSearchParams()
  const requested = params.get('mode')
  const [mode, setMode] = useState<CreateMode>(isCreateMode(requested) ? requested : 'new')
  // Carried over when "New folder" spots that its parent is already the project to add.
  const [existingDraft, setExistingDraft] = useState({ name: '', path: '' })
  const useExisting = (draft: { name: string; path: string }) => {
    setExistingDraft(draft)
    setMode('existing')
  }

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
    // Safe trial: a small repository written by Sillage itself.
    {
      value: 'sample',
      label: t('projects.create.mode.sample'),
      hint: t('projects.create.mode.sample.hint'),
      icon: <Sparkles size={15} />,
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
          {mode === 'new' ? <NewFolderForm onUseExisting={useExisting} /> : null}
          {mode === 'existing' ? <ExistingFolderForm initialName={existingDraft.name} initialPath={existingDraft.path} /> : null}
          {mode === 'sample' ? <SampleProjectForm /> : null}
        </CardBody>
      </Card>
    </div>
  )
}

/**
 * Shortcut: enter a name and derive the directory.
 *
 * Directory name follows project name until manually edited; parent directory comes from the
 * last creation. The common case therefore requires only one field.
 */
export function NewFolderForm({ initialName = '', onCreate, onUseExisting, children, pending = false, error: externalError }: {
  initialName?: string
  onCreate?: (input: CreateProjectInput) => void
  /** Offered when the parent is itself a project: register it instead of nesting a new folder. */
  onUseExisting?: (draft: { name: string; path: string }) => void
  children?: ReactNode
  pending?: boolean
  error?: string
} = {}) {
  const t = useTranslate()
  const sharedProjects = useCapability('sharedProjects')
  const createProject = useCreateProject()
  const navigate = useNavigate()
  const { data: settings } = useUserSettings()
  const visibilityOptions = useVisibilityOptions()

  const [name, setName] = useState(initialName)
  const [directory, setDirectory] = useState(slugifyProjectName(initialName))
  const [parentDir, setParentDir] = useState('')
  const [folderPaths, setFolderPaths] = useState<string[]>([])
  const [visibility, setVisibility] = useState<Visibility>('private')
  const [instructionsMode, setInstructionsMode] = useInstructionsModeChoice()

  // Settings arrive after first render: apply the remembered directory only to
  // an empty field, never over user input.
  useEffect(() => {
    if (settings?.projectsDir) setParentDir((current) => current || settings.projectsDir!)
  }, [settings?.projectsDir])

  const applyName = (next: string) => {
    if (directory === slugifyProjectName(name)) setDirectory(slugifyProjectName(next))
    setName(next)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const input = {
        name: name.trim(),
        parentDir,
        directory: directory.trim(),
        folderPaths,
        visibility,
        ...instructionsModeField(instructionsMode),
      }
    if (onCreate) return onCreate(input)
    createProject.mutate(input, {
        onSuccess: (project) => navigate(`/p/${project.id}/c/new`),
      },
    )
  }

  const error =
    createProject.error instanceof ApiRequestError ? createProject.error.message : null
  const parent = parentDir.trim().replace(/(.)[\\/]+$/, '$1')
  const preview = parent && directory.trim() ? `${parent}/${directory.trim()}` : null
  // Pointing "Projects folder" at the project itself creates `devtools/devtools`: the usual
  // mistake when someone adds an existing project without switching to "Existing folder".
  const parentIsProject = useLooksLikeProject(parent)
  const parentName = parent.split(/[\\/]/).pop() ?? ''
  const sameName = Boolean(parentName) && parentName.toLowerCase() === directory.trim().toLowerCase()
  const nested = preview && (parentIsProject || sameName)

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
        hint={t('projects.create.directory.hint')}
        autoCapitalize="none"
        autoCorrect="off"
        required
      />
      {nested ? (
        <Banner tone="caution">
          <span className="flex flex-col items-start gap-2">
            <span>
              {t(parentIsProject ? 'projects.create.nested.project' : 'projects.create.nested.sameName', { parent: parentName })}
            </span>
            {onUseExisting ? (
              <Button
                type="button"
                variant="secondary"
                icon={<FolderOpen size={15} />}
                onClick={() => onUseExisting({ name: name.trim(), path: parent })}
              >
                {t('projects.create.nested.useExisting')}
              </Button>
            ) : null}
          </span>
        </Banner>
      ) : null}
      <NewProjectFolders paths={folderPaths} onChange={setFolderPaths} initialPath={parentDir} />
      {sharedProjects ? (
        <Select
          label={t('project.settings.visibility')}
          value={visibility}
          onChange={setVisibility}
          options={visibilityOptions}
        />
      ) : null}
      <InstructionsModeSelect value={instructionsMode} onChange={setInstructionsMode} />
      {children}
      {preview ? (
        <p className="flex flex-col gap-1 rounded-md border border-line bg-surface-high px-3 py-2 text-sm text-ink-soft">
          {t('projects.create.preview.label')}
          <span className="break-all font-mono text-ink">{preview}</span>
        </p>
      ) : null}
      {externalError || error ? <Banner>{externalError ?? error}</Banner> : null}
      <Button type="submit" disabled={pending || createProject.isPending} className="self-start">
        {createProject.isPending ? t('projects.create.pending') : t('projects.create.submit')}
      </Button>
    </form>
  )
}

/** An existing directory anywhere on the machine: nothing is created. */
function ExistingFolderForm({ initialName = '', initialPath = '' }: { initialName?: string; initialPath?: string }) {
  const t = useTranslate()
  const sharedProjects = useCapability('sharedProjects')
  const createProject = useCreateProject()
  const navigate = useNavigate()
  const visibilityOptions = useVisibilityOptions()

  const [name, setName] = useState(initialName)
  const [workspacePath, setWorkspacePath] = useState(initialPath)
  const [folderPaths, setFolderPaths] = useState<string[]>([])
  const [visibility, setVisibility] = useState<Visibility>('private')
  const [instructionsMode, setInstructionsMode] = useInstructionsModeChoice()

  const submit = (event: FormEvent) => {
    event.preventDefault()
    createProject.mutate(
      { name: name.trim(), workspacePath, folderPaths, visibility, ...instructionsModeField(instructionsMode) },
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
      <NewProjectFolders paths={folderPaths} onChange={setFolderPaths} initialPath={workspacePath} />
      {sharedProjects ? (
        <Select
          label={t('project.settings.visibility')}
          value={visibility}
          onChange={setVisibility}
          options={visibilityOptions}
        />
      ) : null}
      <InstructionsModeSelect value={instructionsMode} onChange={setInstructionsMode} />
      {error ? <Banner>{error}</Banner> : null}
      <Button type="submit" disabled={createProject.isPending} className="self-start">
        {createProject.isPending ? t('projects.create.pending') : t('projects.create.submit')}
      </Button>
    </form>
  )
}
