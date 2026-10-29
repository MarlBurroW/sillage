import { SkillLoading, SkillSpinner } from './SkillLoading'
import { Check, Circle } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { skillNameSchema, type LibrarySkillScope } from '@sillage/protocol'
import { useTranslate } from '../../lib/i18n'
import { useInstallDiscoveredSkill, useSourcePreview, type DiscoverableSkill } from '../../lib/skill-sources'
import { Banner, Select } from '../ui'
import { useSkillPermissions } from './permissions'
import { NameField, SkillDialog } from './SkillDialog'

/** A specific skill stays visible while its source is prepared, including on failure. */
export function InstallSkillDialog({ candidate, scope, projectId, onClose }: {
  candidate: DiscoverableSkill
  scope: LibrarySkillScope
  projectId: string | null
  onClose: () => void
}) {
  const t = useTranslate()
  const permissions = useSkillPermissions()
  const install = useInstallDiscoveredSkill()
  const originalName = candidate.kind === 'source' ? candidate.skill.name : candidate.result.name
  const repository = candidate.kind === 'source' ? candidate.source.name : candidate.result.repository
  const [target, setTarget] = useState(scope === 'global' ? 'global' : projectId ?? '')
  const destination = permissions.destinations.find((entry) => entry.value === target) ?? permissions.destinations[0]
  const [name, setName] = useState(skillNameSchema.safeParse(originalName).success ? originalName : '')
  const [reading, setReading] = useState(false)
  const preview = useSourcePreview(
    reading && candidate.kind === 'source' ? candidate.source.id : null,
    candidate.kind === 'source' ? candidate.skill.path : null,
  )
  return <SkillDialog open onClose={onClose} title={t('skills.install.title', { name: originalName })}
    submitLabel={t(install.isSuccess ? 'skills.install.done' : install.isPending ? 'skills.catalog.installing' : 'skills.install.submit')}
    busy={install.isPending} hideCancel={install.isSuccess}
    canSubmit={install.isSuccess || (!!destination && skillNameSchema.safeParse(name).success)}
    onSubmit={() => {
      if (install.isSuccess) return onClose()
      if (destination) install.mutate({ candidate, scope: destination.scope, projectId: destination.projectId, name })
    }}>
    <p className="break-words text-sm text-ink-faint">{repository}</p>
    {install.isSuccess ? <>
      <p role="status" className="text-sm text-positive">{t('skills.install.success', { name: install.data.name })}</p>
      <Link to={`/skills/${install.data.id}`} className="text-sm text-accent hover:underline">{t('skills.install.open')}</Link>
    </> : <>
      <p className="text-sm text-ink-soft">{t(candidate.kind === 'directory' ? 'skills.install.explanation' : 'skills.install.savedExplanation')}</p>
      <Select label={t('skills.field.destination')} value={destination?.value ?? ''} disabled={install.isPending}
        onChange={setTarget} options={permissions.destinations.map((entry) => ({ value: entry.value, label: entry.label }))} />
      <NameField value={name} onChange={setName} disabled={install.isPending} />
      {!destination ? <Banner>{t('skills.catalog.noDestination')}</Banner> : null}
      {candidate.kind === 'source' ? <>
        <p className="text-sm text-ink-soft">{candidate.skill.description}</p>
        {candidate.skill.scripts ? <Banner tone="caution">{t('skills.compat.runs_scripts')}</Banner> : null}
        <details onToggle={(event) => setReading(event.currentTarget.open)}>
          <summary className="cursor-pointer text-sm text-ink-soft">{t('skills.install.contents')}</summary>
          {preview.isFetching ? <SkillLoading label={t('skills.loading.preview')} rows={1} /> : null}
          {preview.error ? <Banner>{preview.error.message}</Banner> : null}
          {preview.data ? <pre className="mt-2 whitespace-pre-wrap break-words text-xs text-ink-faint">{preview.data.main}</pre> : null}
        </details>
      </> : null}
      {install.isPending ? <div className="border-l-2 border-accent bg-accent-wash p-4">
        <p role="status" className="sr-only">{t(install.phase === 'skill' ? 'skills.install.skillStep' : 'skills.install.sourceStep')}</p>
        <ol className="space-y-3 text-sm">
          {(['source', 'skill'] as const).map((step, index) => {
            const active = (install.phase ?? 'source') === step
            const done = step === 'source' && install.phase === 'skill'
            return <li key={step} aria-current={active ? 'step' : undefined} className={`flex items-center gap-2 ${active ? 'text-accent' : done ? 'text-positive' : 'text-ink-faint'}`}>
              {done ? <Check size={16} aria-hidden="true" /> : active ? <SkillSpinner /> : <Circle size={16} aria-hidden="true" />}
              <span>{index + 1}. {t(step === 'source' ? 'skills.install.sourceStep' : 'skills.install.skillStep')}</span>
            </li>
          })}
        </ol>
      </div> : null}
      {install.error ? <Banner>{install.error.message}</Banner> : null}
    </>}
  </SkillDialog>
}
