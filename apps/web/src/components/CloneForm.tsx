import { GitBranch, Globe, Lock } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { parseRemoteUrl, type GitRepoDto } from '@sillage/protocol'
import { Link } from 'react-router-dom'
import { ApiRequestError } from '../lib/api'
import { GITHUB_HOST, useGitCredentials } from '../lib/git-credentials'
import { translateError, useTranslate } from '../lib/i18n'
import { useCloneJob, useStartClone } from '../lib/projects'
import {
  InstructionsModeSelect,
  instructionsModeField,
  useInstructionsModeChoice,
} from './instructions/Instructions'
import { useUserSettings } from '../lib/user-settings'
import { PathField } from './PathField'
import { useCapability } from '../lib/instance'
import { RepoCombobox } from './RepoCombobox'
import { Banner, Button, Field, Select, type SelectOption } from './ui'

/**
 * Directory name Git would choose for the URL, empty until valid. Remains editable because
 * same-named repositories from different owners cannot share a parent directory; users decide
 * rather than Sillage silently renaming.
 */
function directoryFromUrl(url: string): string {
  return parseRemoteUrl(url)?.repo ?? ''
}

export function CloneForm() {
  const t = useTranslate()
  const sharedProjects = useCapability('sharedProjects')
  const { data: credentials } = useGitCredentials()
  const savedHosts = credentials?.credentials.map((entry) => entry.host) ?? []
  const hasGitHub = savedHosts.includes(GITHUB_HOST)

  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [parentDir, setParentDir] = useState('')
  const [directory, setDirectory] = useState('')
  const [visibility, setVisibility] = useState<'private' | 'shared'>('private')
  const [instructionsMode, setInstructionsMode] = useInstructionsModeChoice()
  const [jobId, setJobId] = useState<string | null>(null)

  const startClone = useStartClone()
  const { data: job } = useCloneJob(jobId)
  const { data: settings } = useUserSettings()

  // Offer the same parent directory as newly created projects without overwriting existing input.
  useEffect(() => {
    if (settings?.projectsDir) setParentDir((current) => current || settings.projectsDir!)
  }, [settings?.projectsDir])

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

  /** Both derived fields follow URL until manually edited. */
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
      {
        url: url.trim(),
        name: name.trim(),
        parentDir,
        directory: directory.trim(),
        visibility,
        ...instructionsModeField(instructionsMode),
      },
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
            // Without percentages Git is in an unmeasured phase: a zero bar would misleadingly imply no activity.
            style={{ width: `${job.percent ?? 5}%` }}
          />
        </div>
      </div>
    )
  }

  const startError = startClone.error instanceof ApiRequestError ? startClone.error.message : null

  /**
   * Target host once input resembles a URL, warning before submission when private repositories
   * lack access. Public repositories need no token, so warnings never block or claim to know
   * privacy before trying.
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
      {sharedProjects ? (
        <Select
          label={t('project.settings.visibility')}
          value={visibility}
          onChange={setVisibility}
          options={VISIBILITY_OPTIONS}
        />
      ) : null}
      <InstructionsModeSelect value={instructionsMode} onChange={setInstructionsMode} />

      {job?.error ? (
        <Banner>
          {translateError(job.error.code, job.error.message)}{' '}
          {/*
           * Authentication is the only failure fixable one click away: link directly instead of
           * making users search settings.
           */}
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
