import { useQueryClient } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { useState } from 'react'
import type { LibrarySkillDto } from '@sillage/protocol'
import { api } from '../../lib/api'
import { useTranslate } from '../../lib/i18n'
import { useApplySkillUpdate, useRefreshSkillSource, useSkillSources } from '../../lib/skill-sources'
import { Badge, Banner, Button } from '../ui'
import { useSkillPermissions } from './permissions'
import { UpdateDialog } from './UpdateDialog'

/** Combine discovery, review, and application without leaving the library. */
export function SkillUpdates({ skills }: { skills: LibrarySkillDto[] }) {
  const t = useTranslate()
  const queryClient = useQueryClient()
  const permissions = useSkillPermissions()
  const sources = useSkillSources()
  const refresh = useRefreshSkillSource()
  const apply = useApplySkillUpdate()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [review, setReview] = useState<LibrarySkillDto | null>(null)
  const [busy, setBusy] = useState<'check' | 'apply' | null>(null)
  const [checked, setChecked] = useState(false)
  const [errors, setErrors] = useState<string[]>([])
  const [failedSources, setFailedSources] = useState<Set<string>>(new Set())
  const [completed, setCompleted] = useState(0)
  const linked = new Set(skills.map((skill) => skill.origin?.sourceId).filter(Boolean))
  const relevant = (sources.data?.sources ?? []).filter((source) => source.enabled && linked.has(source.id))
  const activeSources = new Set(relevant.map((source) => source.id))
  const pending = skills.filter((skill) => skill.updateAvailable && skill.origin?.sourceId && activeSources.has(skill.origin.sourceId))
  const eligible = (skill: LibrarySkillDto) => !skill.locallyModified && !skill.problem &&
    permissions.canWrite(skill.scope, skill.projectId) && !failedSources.has(skill.origin?.sourceId ?? '')
  const available = pending.filter(eligible)
  const selection = available.filter((skill) => selected.has(skill.id))
  const message = (error: unknown) => error instanceof Error ? error.message : t('skills.batch.error')

  const check = async () => {
    if (busy) return
    setBusy('check')
    setErrors([])
    setCompleted(0)
    setSelected(new Set())
    const failed = new Set<string>()
    for (const source of relevant) {
      try { await refresh.mutateAsync(source.id) }
      catch (error) {
        failed.add(source.id)
        setErrors((previous) => [...previous, `${source.name} : ${message(error)}`])
      }
    }
    setFailedSources(failed)
    setChecked(true)
    setBusy(null)
  }

  const update = async () => {
    if (busy) return
    setBusy('apply')
    setErrors([])
    setCompleted(0)
    // Recheck local state before each write because the list may predate edits.
    for (const skill of selection) {
      try {
        const latest = await api.get<LibrarySkillDto>(`/api/skill-library/${skill.id}`)
        if (latest.locallyModified || latest.problem) throw new Error(t('skills.updates.reviewRequired'))
        if (latest.updateAvailable) {
          await apply.mutateAsync(skill.id)
          setCompleted((count) => count + 1)
        }
        setSelected((previous) => { const next = new Set(previous); next.delete(skill.id); return next })
      } catch (error) {
        setErrors((previous) => [...previous, `${skill.name} : ${message(error)}`])
      }
    }
    await queryClient.invalidateQueries({ queryKey: ['skill-library'] })
    setBusy(null)
  }

  if (linked.size === 0) return null
  return <section className="rounded-lg border border-line p-4" aria-label={t('skills.updates.title')}>
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 className="text-sm font-semibold">{t('skills.updates.title')}</h2>
        <p className="mt-1 text-xs text-ink-faint">{t('skills.updates.description')}</p>
      </div>
      {permissions.isAdmin ? <Button size="sm" variant="secondary" icon={<RefreshCw size={14} className={busy === 'check' ? 'animate-spin' : undefined} />}
        disabled={busy !== null || relevant.length === 0 || sources.isFetching} onClick={() => void check()}>
        {t(busy === 'check' ? 'skills.updates.checking' : 'skills.updates.check')}
      </Button> : null}
    </div>
    {sources.error ? <Banner>{sources.error.message}</Banner> : null}
    {checked && !busy ? <p role="status" className="mt-3 text-sm text-ink-soft">
      {t(errors.length > 0 ? 'skills.updates.partial' : pending.length === 0 ? 'skills.updates.current' : 'skills.updates.found', { count: pending.length })}
    </p> : null}
    {pending.length > 0 ? <>
      <div className="my-3 flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
        <Button size="sm" variant="ghost" disabled={busy !== null || available.length === 0} onClick={() => setSelected(selection.length === available.length ? new Set() : new Set(available.map((skill) => skill.id)))}>
          {t(selection.length === available.length && available.length > 0 ? 'skills.batch.clearVisible' : 'skills.batch.selectVisible')}
        </Button>
        <Button size="sm" disabled={busy !== null || selection.length === 0} onClick={() => void update()}>
          {t(busy === 'apply' ? 'skills.update.applying' : 'skills.updates.applySelected', { count: selection.length })}
        </Button>
      </div>
      <ul className="divide-y divide-line">
        {pending.map((skill) => <li key={skill.id} className="flex items-center gap-3 py-3">
          <label className="flex min-h-11 w-7 shrink-0 items-center justify-center">
            <input type="checkbox" aria-label={t('skills.batch.select', { name: skill.name })} checked={eligible(skill) && selected.has(skill.id)}
              disabled={busy !== null || !eligible(skill)} onChange={() => setSelected((previous) => {
                const next = new Set(previous)
                if (next.has(skill.id)) next.delete(skill.id)
                else next.add(skill.id)
                return next
              })} className="size-4 accent-accent" />
          </label>
          <div className="min-w-0 flex-1">
            <p className="break-words text-sm font-medium">{skill.name}</p>
            <p className="break-words text-xs text-ink-faint">{skill.origin?.sourceName}</p>
            {skill.locallyModified ? <Badge tone="caution">{t('skills.badge.modified')}</Badge> : null}
          </div>
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setReview(skill)}>{t('skills.updates.review')}</Button>
        </li>)}
      </ul>
      {pending.some((skill) => skill.locallyModified) ? <p className="mt-2 text-xs text-ink-faint">{t('skills.updates.localHint')}</p> : null}
    </> : null}
    {completed > 0 ? <p role="status" className="mt-3 text-sm text-positive">{t('skills.updates.completed', { count: completed })}</p> : null}
    {errors.map((error, index) => <div key={index} className="mt-2"><Banner>{error}</Banner></div>)}
    {review ? <UpdateDialog key={review.id} open onClose={() => setReview(null)} skill={review} canWrite={permissions.canWrite(review.scope, review.projectId)} /> : null}
  </section>
}
