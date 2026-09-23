import {
  ChevronRight,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Globe,
  Lock,
  MessagesSquare,
} from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { slugifyProjectName } from '@sillage/protocol'
import { ApiRequestError } from '../lib/api'
import { useCreateProject, useProjects } from '../lib/projects'
import { useUserSettings } from '../lib/user-settings'
import { CloneForm } from '../components/CloneForm'
import { PathField } from '../components/PathField'
import { SectionHeader } from './SettingsPage'
import { useTranslate } from '../lib/i18n'
import {
  Badge,
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  ChoiceList,
  EmptyState,
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

export function ProjectsSettingsPage() {
  const t = useTranslate()
  const { data: projects } = useProjects()
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
    <div className="flex flex-col gap-4">
      <SectionHeader title={t('projects.title')} description={t('projects.description')} />

      <Card>
        <CardHeader
          title={t('projects.create.title')}
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

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-ink-soft">{t('projects.existing.title')}</h2>

        {projects && projects.length > 0 ? (
          projects.map((project) => (
            <Card key={project.id}>
              <Link
                to={`/p/${project.id}`}
                className="flex items-center gap-3 px-5 py-4 transition-colors hover:text-accent"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate font-medium">{project.name}</p>
                    <Badge
                      tone={project.visibility === 'shared' ? 'accent' : 'neutral'}
                      icon={project.visibility === 'shared' ? <Globe size={11} /> : <Lock size={11} />}
                    >
                      {project.visibility === 'shared'
                        ? t('project.visibility.shared')
                        : t('project.visibility.private')}
                    </Badge>
                  </div>
                  <p className="mt-0.5 truncate font-mono text-xs text-ink-faint">
                    {project.workspacePath}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-faint">
                    <span>{project.ownerName}</span>
                    <span className="flex items-center gap-1">
                      <MessagesSquare size={12} />
                      {project.conversationCount}
                    </span>
                    {project.git ? <span className="font-mono">{project.git.branch}</span> : null}
                  </div>
                </div>
                <ChevronRight size={16} className="shrink-0 text-ink-faint" />
              </Link>
            </Card>
          ))
        ) : (
          <Card>
            <EmptyState
              icon={<FolderOpen size={22} />}
              title={t('projects.empty.title')}
              description={t('projects.empty.description')}
            />
          </Card>
        )}
      </section>
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
  const { data: settings } = useUserSettings()
  const visibilityOptions = useVisibilityOptions()

  const [name, setName] = useState('')
  const [directory, setDirectory] = useState('')
  const [parentDir, setParentDir] = useState('')
  const [visibility, setVisibility] = useState<Visibility>('private')

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
      { name: name.trim(), parentDir, directory: directory.trim(), visibility },
      {
        onSuccess: () => {
          // Le dossier parent reste : c'est précisément ce qu'on ne veut plus retaper.
          setName('')
          setDirectory('')
        },
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
  const visibilityOptions = useVisibilityOptions()

  const [name, setName] = useState('')
  const [workspacePath, setWorkspacePath] = useState('')
  const [visibility, setVisibility] = useState<Visibility>('private')

  const submit = (event: FormEvent) => {
    event.preventDefault()
    createProject.mutate(
      { name: name.trim(), workspacePath, visibility },
      {
        onSuccess: () => {
          setName('')
          setWorkspacePath('')
        },
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
      {error ? <Banner>{error}</Banner> : null}
      <Button type="submit" disabled={createProject.isPending} className="self-start">
        {createProject.isPending ? t('projects.create.pending') : t('projects.create.submit')}
      </Button>
    </form>
  )
}
