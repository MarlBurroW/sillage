import { ChevronRight, FolderOpen, Globe, Lock, MessagesSquare } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { ApiRequestError } from '../lib/api'
import { useCreateProject, useProjects, type CreateProjectInput } from '../lib/projects'
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
  EmptyState,
  Field,
  Select,
  type SelectOption,
} from '../components/ui'

const EMPTY_FORM: CreateProjectInput = {
  name: '',
  workspacePath: '',
  visibility: 'private',
}

export function ProjectsSettingsPage() {
  const t = useTranslate()
  const { data: projects } = useProjects()
  const createProject = useCreateProject()
  const [form, setForm] = useState<CreateProjectInput>(EMPTY_FORM)

  const VISIBILITY_OPTIONS: SelectOption<CreateProjectInput['visibility']>[] = [
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

  const submit = (event: FormEvent) => {
    event.preventDefault()
    createProject.mutate(form, { onSuccess: () => setForm(EMPTY_FORM) })
  }

  const createError =
    createProject.error instanceof ApiRequestError ? createProject.error.message : null

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader title={t('projects.title')} description={t('projects.description')} />

      <Card>
        <CardHeader
          title={t('projects.create.title')}
          description={t('projects.create.description')}
          icon={<FolderOpen size={16} />}
        />
        <CardBody>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <Field
              label={t('projects.create.name')}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder={t('projects.create.name.placeholder')}
              required
            />
            <PathField
              label={t('projects.create.workspacePath')}
              value={form.workspacePath}
              onChange={(workspacePath) => setForm({ ...form, workspacePath })}
              placeholder="/home/marlburrow/projects/mon-projet"
              hint={t('projects.create.workspacePath.hint')}
            />
            <Select
              label={t('project.settings.visibility')}
              value={form.visibility}
              onChange={(visibility) => setForm({ ...form, visibility })}
              options={VISIBILITY_OPTIONS}
            />
            {createError ? <Banner>{createError}</Banner> : null}
            <Button type="submit" disabled={createProject.isPending} className="self-start">
              {createProject.isPending ? t('projects.create.pending') : t('projects.create.submit')}
            </Button>
          </form>
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
