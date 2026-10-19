import { useQueryClient } from '@tanstack/react-query'
import { FolderOpen, FolderPlus, GitBranch, Globe, Lock, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ProjectDto } from '@sillage/protocol'
import { ApiRequestError, api } from '../../lib/api'
import { useTranslate } from '../../lib/i18n'
import { useProjects } from '../../lib/projects'
import { useUserSettings } from '../../lib/user-settings'
import { ExistingFolderForm, NewFolderForm } from '../../routes/NewProjectPage'
import { CloneForm } from '../CloneForm'
import { PathField } from '../PathField'
import { Banner, Button, Select, type SelectOption } from '../ui'
import { CardGrid, ChoiceCard, Question, StepTitle, Tip, Why, useCommit, useGate, type StepProps } from './shell'

type Mode = 'clone' | 'existing' | 'new' | 'sample'

/**
 * Ton premier projet : les trois origines de l'écran de création, plus le projet
 * d'essai. Le projet créé est noté sur la visite, pour l'étape des permissions et pour
 * y ouvrir la première conversation à la fin.
 */
export function ProjectStep({ nav, state, update, profile, homeDir }: StepProps) {
  const t = useTranslate()
  const { data: projects } = useProjects()
  const [mode, setMode] = useState<Mode>('clone')
  const chosen = projects?.find((project) => project.id === state.projectId) ?? null

  useGate(nav, { canContinue: chosen !== null, laterAllowed: true, skipAllowed: true })
  useCommit(nav, null)

  const host = t(profile === 'desktop' ? 'onboarding.host.computer' : 'onboarding.host.server')
  const pick = (projectId: string) => update({ projectId })

  const modes: { value: Mode; icon: React.ReactNode; label: string; hint: string }[] = [
    { value: 'clone', icon: <GitBranch size={15} />, label: t('projects.create.mode.clone'), hint: t('projects.create.mode.clone.hint') },
    { value: 'existing', icon: <FolderOpen size={15} />, label: t('projects.create.mode.existing'), hint: t('projects.create.mode.existing.hint') },
    { value: 'new', icon: <FolderPlus size={15} />, label: t('projects.create.mode.new'), hint: t('projects.create.mode.new.hint') },
    { value: 'sample', icon: <Sparkles size={15} />, label: t('onboarding.project.sample'), hint: t('onboarding.project.sample.hint') },
  ]

  return (
    <>
      <StepTitle title={t('onboarding.project.title')} lead={t('onboarding.project.lead', { host })} />

      {chosen ? (
        <>
          <Banner tone="positive">
            {t('onboarding.project.ready', { name: chosen.name })}{' '}
            <span className="font-mono text-xs text-ink-faint">{chosen.workspacePath}</span>
          </Banner>
          <div>
            <Button variant="ghost" size="sm" onClick={() => update({ projectId: null })}>
              {t('onboarding.project.another')}
            </Button>
          </div>
        </>
      ) : (
        <>
          {projects && projects.length > 0 ? <ExistingProjects projects={projects} onPick={pick} /> : null}
          <Question label={projects && projects.length > 0 ? t('onboarding.project.orCreate') : t('projects.create.mode')}>
            <CardGrid>
              {modes.map((option) => (
                <ChoiceCard
                  key={option.value}
                  selected={mode === option.value}
                  onClick={() => setMode(option.value)}
                  icon={option.icon}
                  label={option.label}
                  hint={option.hint}
                />
              ))}
            </CardGrid>
          </Question>
          {mode === 'clone' ? <CloneForm onCreated={pick} /> : null}
          {mode === 'existing' ? <ExistingFolderForm onCreated={pick} /> : null}
          {mode === 'new' ? <NewFolderForm onCreated={pick} /> : null}
          {mode === 'sample' ? <SampleForm team={state.answers.team === 'team'} homeDir={homeDir} onCreated={pick} /> : null}
        </>
      )}

      <Tip>{t('onboarding.project.more')}</Tip>
    </>
  )
}

/** Une visite rejouée, ou un projet déjà créé ailleurs : on peut continuer dessus. */
function ExistingProjects({ projects, onPick }: { projects: ProjectDto[]; onPick: (id: string) => void }) {
  const t = useTranslate()
  const options: SelectOption<string>[] = projects.map((project) => ({ value: project.id, label: project.name, hint: project.workspacePath }))
  return (
    <Question label={t('onboarding.project.existing')}>
      <Select value="" placeholder={t('onboarding.project.existing.placeholder')} options={options} onChange={onPick} />
    </Question>
  )
}

/**
 * Le projet d'essai : Sillage écrit le dépôt, il n'y a qu'à dire où. Le dossier des
 * projets déjà mémorisé sert de proposition, sinon `projects` sous le dossier personnel.
 */
function SampleForm({ team, homeDir, onCreated }: { team: boolean; homeDir: string; onCreated: (id: string) => void }) {
  const t = useTranslate()
  const queryClient = useQueryClient()
  const { data: settings } = useUserSettings()
  const [parentDir, setParentDir] = useState('')
  const [visibility, setVisibility] = useState<'private' | 'shared'>('private')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const proposed = settings?.projectsDir ?? (homeDir ? `${homeDir.replace(/\/+$/, '')}/projects` : '')
    if (proposed) setParentDir((current) => current || proposed)
  }, [settings?.projectsDir, homeDir])

  const visibilityOptions: SelectOption<'private' | 'shared'>[] = [
    { value: 'private', label: t('project.visibility.private'), icon: <Lock size={15} />, hint: t('project.visibility.private.hint') },
    { value: 'shared', label: t('project.visibility.shared'), icon: <Globe size={15} />, hint: t('project.visibility.shared.hint') },
  ]

  const create = async () => {
    setPending(true)
    setError(null)
    try {
      const project = await api.post<ProjectDto>('/api/projects/sample', { parentDir, visibility })
      await queryClient.invalidateQueries({ queryKey: ['projects'] })
      onCreated(project.id)
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Why>
        <b>{t('onboarding.project.sample.why.title')}</b> {t('onboarding.project.sample.why.body')}
      </Why>
      <PathField
        label={t('projects.create.parentDir')}
        value={parentDir}
        onChange={setParentDir}
        placeholder={t('projects.create.parentDir.placeholder')}
        hint={t('onboarding.project.sample.parentDir.hint')}
        required
      />
      {team ? <Select label={t('project.settings.visibility')} value={visibility} onChange={setVisibility} options={visibilityOptions} /> : null}
      {error ? <Banner>{error}</Banner> : null}
      <Button className="self-start" disabled={pending || !parentDir} onClick={create} icon={<Sparkles size={15} />}>
        {pending ? t('projects.create.pending') : t('onboarding.project.sample.create')}
      </Button>
    </div>
  )
}
