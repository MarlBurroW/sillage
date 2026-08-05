import { GitBranch, Globe, Lock } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { parseRemoteUrl, type GitRepoDto } from '@sillage/protocol'
import { Link } from 'react-router-dom'
import { ApiRequestError } from '../lib/api'
import { GITHUB_HOST, useGitCredentials } from '../lib/git-credentials'
import { translateError, useTranslate } from '../lib/i18n'
import { useCloneJob, useStartClone } from '../lib/projects'
import { PathField } from './PathField'
import { RepoCombobox } from './RepoCombobox'
import { Banner, Button, Field, Select, type SelectOption } from './ui'

/**
 * Nom de dossier que git choisirait pour cette URL, vide tant qu'elle n'en est pas une.
 *
 * Le champ reste modifiable ensuite : deux dépôts homonymes chez deux propriétaires
 * différents ne peuvent pas cohabiter dans le même dossier parent, et c'est à
 * l'utilisateur de trancher, pas à Sillage de renommer dans son dos.
 */
function directoryFromUrl(url: string): string {
  return parseRemoteUrl(url)?.repo ?? ''
}

export function CloneForm() {
  const t = useTranslate()
  const { data: credentials } = useGitCredentials()
  const savedHosts = credentials?.credentials.map((entry) => entry.host) ?? []
  const hasGitHub = savedHosts.includes(GITHUB_HOST)

  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [parentDir, setParentDir] = useState('')
  const [directory, setDirectory] = useState('')
  const [visibility, setVisibility] = useState<'private' | 'shared'>('private')
  const [jobId, setJobId] = useState<string | null>(null)

  const startClone = useStartClone()
  const { data: job } = useCloneJob(jobId)

  const VISIBILITY_OPTIONS: SelectOption<'private' | 'shared'>[] = [
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

  /** Les deux champs dérivés suivent l'URL tant que l'utilisateur ne les a pas repris. */
  const applyUrl = (next: string) => {
    const derived = directoryFromUrl(next)
    if (directory === directoryFromUrl(url)) setDirectory(derived)
    if (name === directoryFromUrl(url)) setName(derived)
    setUrl(next)
  }

  const applyRepo = (repo: GitRepoDto) => {
    setUrl(repo.cloneUrl)
    setDirectory(repo.name)
    setName(repo.name)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    startClone.mutate(
      { url: url.trim(), name: name.trim(), parentDir, directory: directory.trim(), visibility },
      { onSuccess: (created) => setJobId(created.id) },
    )
  }

  if (job?.status === 'done' && job.projectId) {
    return (
      <Banner tone="info">
        {t('clone.done', { name })}{' '}
        <Link to={`/p/${job.projectId}`} className="underline">
          {t('clone.done.open')}
        </Link>
      </Banner>
    )
  }

  if (job?.status === 'running') {
    return (
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between text-sm text-ink-soft">
          <span className="flex items-center gap-2">
            <GitBranch size={15} className="text-ink-faint" />
            {job.phase || t('clone.phase.starting')}
          </span>
          {job.percent === null ? null : <span className="font-mono text-xs">{job.percent} %</span>}
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-sunken">
          <div
            className="h-full bg-accent transition-[width]"
            // Sans pourcentage, git en est à une phase qu'il ne chiffre pas : une barre
            // à zéro laisserait croire que rien ne se passe.
            style={{ width: `${job.percent ?? 5}%` }}
          />
        </div>
      </div>
    )
  }

  const startError = startClone.error instanceof ApiRequestError ? startClone.error.message : null

  /**
   * Hôte visé, quand ce qui est saisi ressemble déjà à une URL.
   *
   * Sert à dire avant l'envoi qu'un dépôt privé de cet hôte sera refusé. Un dépôt public
   * se clone sans jeton, donc l'avertissement ne bloque rien et ne prétend pas savoir si
   * le dépôt est privé : personne ne peut le savoir avant d'essayer.
   */
  const targetHost = parseRemoteUrl(url)?.host ?? null
  const missingCredential = targetHost
    ? !savedHosts.includes(targetHost)
    : savedHosts.length === 0

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {missingCredential ? (
        <Banner tone="info">
          {targetHost
            ? t('clone.private.notice.host', { host: targetHost })
            : t('clone.private.notice')}{' '}
          <Link to="/settings/git" className="underline">
            {t('clone.private.link')}
          </Link>
        </Banner>
      ) : null}

      <RepoCombobox
        value={url}
        onChange={applyUrl}
        onPick={applyRepo}
        hasCredential={hasGitHub}
        hint={hasGitHub ? t('clone.repo.hint') : t('clone.repo.hint.noCredential')}
      />
      <Field
        label={t('projects.create.name')}
        value={name}
        onChange={(event) => setName(event.target.value)}
        placeholder={t('projects.create.name.placeholder')}
        required
      />
      <PathField
        label={t('clone.parentDir')}
        value={parentDir}
        onChange={setParentDir}
        placeholder={t('clone.parentDir.placeholder')}
        hint={t('clone.parentDir.hint')}
        required
      />
      <Field
        label={t('clone.directory')}
        value={directory}
        onChange={(event) => setDirectory(event.target.value)}
        hint={t('clone.directory.hint')}
        autoCapitalize="none"
        autoCorrect="off"
        required
      />
      <Select
        label={t('project.settings.visibility')}
        value={visibility}
        onChange={setVisibility}
        options={VISIBILITY_OPTIONS}
      />

      {job?.error ? (
        <Banner>
          {translateError(job.error.code, job.error.message)}{' '}
          {/* L'échec d'authentification est le seul dont la réparation est à un clic
              d'ici : y mener vaut mieux que de laisser chercher dans les réglages. */}
          {job.error.code === 'clone_auth_failed' ? (
            <Link to="/settings/git" className="underline">
              {t('clone.private.link')}
            </Link>
          ) : null}
        </Banner>
      ) : null}
      {startError ? <Banner>{startError}</Banner> : null}

      <Button type="submit" disabled={startClone.isPending} className="self-start">
        {startClone.isPending ? t('clone.pending') : t('clone.submit')}
      </Button>
    </form>
  )
}
