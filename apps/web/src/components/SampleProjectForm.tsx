import { useQueryClient } from '@tanstack/react-query'
import { Globe, Lock, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ProjectDto } from '@sillage/protocol'
import { ApiRequestError, api } from '../lib/api'
import { useTranslate } from '../lib/i18n'
import { useInstance } from '../lib/instance'
import { useUserSettings } from '../lib/user-settings'
import { PathField } from './PathField'
import { Banner, Button, Select, type SelectOption } from './ui'

/**
 * Le projet d'essai : Sillage écrit un petit dépôt, avec des tests qui échouent exprès,
 * et crée le projet dessus. Il n'y a qu'à dire où. Le dossier des projets déjà mémorisé
 * sert de proposition, sinon `projects` sous le dossier personnel du serveur.
 */
export function SampleProjectForm() {
  const t = useTranslate()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { data: settings } = useUserSettings()
  const { data: instance } = useInstance()
  const [parentDir, setParentDir] = useState('')
  const [visibility, setVisibility] = useState<'private' | 'shared'>('private')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const homeDir = instance?.homeDir ?? ''
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
      navigate(`/p/${project.id}/c/new`)
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-ink-soft">{t('projects.create.sample.explain')}</p>
      <PathField
        label={t('projects.create.parentDir')}
        value={parentDir}
        onChange={setParentDir}
        placeholder={t('projects.create.parentDir.placeholder')}
        hint={t('projects.create.sample.parentDir.hint')}
        required
      />
      <Select label={t('project.settings.visibility')} value={visibility} onChange={setVisibility} options={visibilityOptions} />
      {error ? <Banner>{error}</Banner> : null}
      <Button className="self-start" disabled={pending || !parentDir} onClick={create} icon={<Sparkles size={15} />}>
        {pending ? t('projects.create.pending') : t('projects.create.sample.create')}
      </Button>
    </div>
  )
}
