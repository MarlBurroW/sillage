import { ChevronRight, FolderOpen, Globe, Lock, MessagesSquare } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { ApiRequestError } from '../lib/api'
import { useCreateProject, useProjects, type CreateProjectInput } from '../lib/projects'
import { PathField } from '../components/PathField'
import { SectionHeader } from './SettingsPage'
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

const VISIBILITY_OPTIONS: SelectOption<CreateProjectInput['visibility']>[] = [
  {
    value: 'private',
    label: 'Privé',
    icon: <Lock size={15} />,
    hint: 'Visible par toi seul',
  },
  {
    value: 'shared',
    label: 'Partagé',
    icon: <Globe size={15} />,
    hint: 'Visible par tous les comptes',
  },
]

export function ProjectsSettingsPage() {
  const { data: projects } = useProjects()
  const createProject = useCreateProject()
  const [form, setForm] = useState<CreateProjectInput>(EMPTY_FORM)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    createProject.mutate(form, { onSuccess: () => setForm(EMPTY_FORM) })
  }

  const createError =
    createProject.error instanceof ApiRequestError ? createProject.error.message : null

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader title="Projets" description="Un projet est un répertoire de travail et sa visibilité." />

      <Card>
        <CardHeader
          title="Nouveau projet"
          description="Sillage pointe sur un dossier existant, il ne le crée pas et n'y touche pas. Le CLI se choisit à chaque conversation, pas ici."
          icon={<FolderOpen size={16} />}
        />
        <CardBody>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <Field
              label="Nom"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Mon projet"
              required
            />
            <PathField
              label="Dossier du workspace"
              value={form.workspacePath}
              onChange={(workspacePath) => setForm({ ...form, workspacePath })}
              placeholder="/home/marlburrow/projects/mon-projet"
              hint="Chemin absolu sur la machine hôte, ou parcours l'arborescence."
            />
            <Select
              label="Visibilité"
              value={form.visibility}
              onChange={(visibility) => setForm({ ...form, visibility })}
              options={VISIBILITY_OPTIONS}
            />
            {createError ? <Banner>{createError}</Banner> : null}
            <Button type="submit" disabled={createProject.isPending} className="self-start">
              {createProject.isPending ? 'Création...' : 'Créer le projet'}
            </Button>
          </form>
        </CardBody>
      </Card>

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-ink-soft">Existants</h2>

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
                      {project.visibility === 'shared' ? 'Partagé' : 'Privé'}
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
              title="Aucun projet pour le moment"
              description="Crée-en un avec le formulaire ci-dessus."
            />
          </Card>
        )}
      </section>
    </div>
  )
}
