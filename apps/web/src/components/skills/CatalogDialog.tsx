import * as Dialog from '@radix-ui/react-dialog'
import { Library, X } from 'lucide-react'
import { useState } from 'react'
import { skillNameSchema, type LibrarySkillScope, type SourceSkillDto } from '@sillage/protocol'
import { ApiRequestError } from '../../lib/api'
import { useTranslate } from '../../lib/i18n'
import {
  shortCommit,
  useInstallSourceSkill,
  useSkillSources,
  useSourceCatalog,
  useSourcePreview,
} from '../../lib/skill-sources'
import { Badge, Banner, Button, EmptyState, IconButton, Select, cx } from '../ui'
import { useSkillPermissions } from './permissions'
import { NameField } from './SkillDialog'

/**
 * Le catalogue des sources : relire les skills et installer une sélection sans quitter la source.
 *
 * L'aperçu montre le `SKILL.md` brut, tel que le modèle le recevra, et la liste des
 * fichiers qui viendront avec : un skill tiers entre dans le contexte des agents et ses
 * scripts s'exécutent avec leurs droits. On l'installe en connaissance de cause.
 */
export function CatalogDialog({
  open,
  onClose,
  sourceId,
  skillName,
  scope,
  projectId,
}: {
  open: boolean
  onClose: () => void
  /** Source ouverte d'abord ; à défaut, la première récupérée. */
  sourceId?: string | null
  /** Skill montré d'emblée, par son nom : celui qu'on a choisi dans une recherche skills.sh. */
  skillName?: string | null
  scope: LibrarySkillScope
  projectId: string | null
}) {
  const t = useTranslate()
  const permissions = useSkillPermissions()
  const [target, setTarget] = useState(scope === 'global' ? 'global' : projectId ?? '')
  const destination = permissions.destinations.find((entry) => entry.value === target) ?? permissions.destinations[0]
  const install = useInstallSourceSkill()
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [completed, setCompleted] = useState(0)
  const { data } = useSkillSources()
  const fetched = (data?.sources ?? []).filter((source) => source.enabled && source.lastCommit !== null)
  const [chosen, setChosen] = useState<string | null>(sourceId ?? null)
  const current = fetched.find((source) => source.id === chosen) ?? fetched[0] ?? null
  const { data: catalog, isPending, error: catalogError } = useSourceCatalog(open && current ? current.id : null)
  // Le filtre part du skill demandé : au doigt, la liste réduite à lui laisse son aperçu
  // juste en dessous. Le vider rend le reste du dépôt.
  const [filter, setFilter] = useState(skillName ?? '')
  const [selected, setSelected] = useState<string | null>(null)
  const [wanted, setWanted] = useState(skillName ?? null)
  const needle = filter.trim().toLowerCase()
  const skills = (catalog?.skills ?? []).filter(
    (skill) =>
      !needle ||
      skill.name.toLowerCase().includes(needle) ||
      skill.path.toLowerCase().includes(needle) ||
      skill.description.toLowerCase().includes(needle),
  )
  const focused =
    skills.find((skill) => skill.path === selected) ?? (selected === null && wanted ? findByName(skills, wanted) : null)
  // Rapporté au catalogue entier : un filtre retouché ne fait pas disparaître le skill du dépôt.
  const missing = selected === null && wanted !== null && catalog !== undefined && findByName(catalog.skills, wanted) === null

  const eligible = (skill: SourceSkillDto) => !skill.problem && !skill.installed.some((entry) =>
    entry.scope === destination?.scope && entry.projectId === destination?.projectId)
  const available = skills.filter(eligible)
  const toggle = (path: string) => setChecked((previous) => {
    const next = new Set(previous)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    return next
  })
  const installSelected = async () => {
    if (!current || !destination || busy) return
    setBusy(true)
    setErrors({})
    setCompleted(0)
    // Chaque succès est conservé : un conflit de nom ne bloque pas les autres skills.
    for (const skill of (catalog?.skills ?? []).filter((item) => checked.has(item.path) && eligible(item))) {
      try {
        await install.mutateAsync({ sourceId: current.id, path: skill.path, scope: destination.scope, projectId: destination.projectId })
        setCompleted((count) => count + 1)
        setChecked((previous) => { const next = new Set(previous); next.delete(skill.path); return next })
      } catch (error) {
        setErrors((previous) => ({ ...previous, [skill.path]: error instanceof ApiRequestError ? error.message : t('skills.batch.error') }))
      }
    }
    setBusy(false)
  }
  const close = () => { if (!busy) onClose() }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) close() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/35 backdrop-blur-sm" />
        <Dialog.Content
          aria-describedby={undefined}
          className="surface fixed inset-x-0 bottom-0 z-50 flex h-[92dvh] flex-col rounded-t-2xl border border-line shadow-pop sm:inset-x-auto sm:top-1/2 sm:bottom-auto sm:left-1/2 sm:h-[min(80dvh,760px)] sm:w-[min(1040px,calc(100vw-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl"
        >
          <header className="flex items-center gap-3 border-b border-line px-5 py-3">
            <Dialog.Title className="flex-1 text-lg font-semibold">{t('skills.catalog.title')}</Dialog.Title>
            <IconButton label={t('skills.dialog.close')} onClick={close} disabled={busy}>
              <X size={18} />
            </IconButton>
          </header>

          {fetched.length === 0 ? (
            <EmptyState icon={<Library size={22} />} title={t('skills.catalog.noSource')} description={t('skills.catalog.noSource.hint')} />
          ) : (
            // Sur téléphone, la liste cède sa place à l'aperçu ; la sélection reste conservée.
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
              <div className={cx('flex min-h-0 flex-1 flex-col gap-3 border-line p-4 md:w-80 md:flex-none md:border-r', focused && 'hidden md:flex')}>
                <Select
                  label={t('skills.catalog.source')}
                  value={current?.id ?? ''}
                  disabled={busy}
                  onChange={(id) => { setChosen(id); setSelected(null); setWanted(null); setChecked(new Set()); setErrors({}); setCompleted(0); setFilter('') }}
                  options={fetched.map((source) => ({
                    value: source.id,
                    label: `${source.name} · ${shortCommit(source.lastCommit)}`,
                  }))}
                />
                <input
                  disabled={busy}
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder={t('skills.catalog.filter')}
                  aria-label={t('skills.catalog.filter')}
                  className="tap-target rounded-md border border-line bg-sunken px-3 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-accent"
                />
                <Button size="sm" variant="ghost" disabled={busy || available.length === 0} onClick={() => setChecked((previous) => {
                  const next = new Set(previous)
                  if (available.every((skill) => next.has(skill.path))) available.forEach((skill) => next.delete(skill.path))
                  else available.forEach((skill) => next.add(skill.path))
                  return next
                })}>{t(available.length > 0 && available.every((skill) => checked.has(skill.path)) ? 'skills.batch.clearVisible' : 'skills.batch.selectVisible')}</Button>
                {isPending ? <p role="status" className="text-sm text-ink-faint">{t('skills.files.loading')}</p> : null}
                {catalogError ? <Banner>{catalogError.message}</Banner> : null}
                <ul className="-mx-1 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
                  {skills.map((skill) => (
                    <li key={skill.path}>
                      <div className="flex items-start gap-1">
                        <label className="flex min-h-11 w-9 shrink-0 items-center justify-center">
                          <input type="checkbox" aria-label={t('skills.batch.select', { name: skill.name })} checked={checked.has(skill.path)}
                            disabled={busy || !eligible(skill)} onChange={() => toggle(skill.path)} className="size-4 accent-accent" />
                        </label>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setSelected(skill.path)}
                        className={cx(
                          'flex min-w-0 flex-1 flex-col gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors',
                          focused?.path === skill.path ? 'bg-accent-wash' : 'hover:bg-surface-high',
                        )}
                      >
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="font-mono text-sm font-medium text-ink">{skill.name}</span>
                          <CatalogBadges skill={skill} />
                        </span>
                        <span className="line-clamp-2 text-xs text-ink-faint">{skill.description}</span>
                      </button>
                      </div>
                      {errors[skill.path] ? <p role="alert" className="px-2 pb-2 text-xs text-critical">{errors[skill.path]}</p> : null}
                    </li>
                  ))}
                  {skills.length === 0 ? <li className="px-2.5 py-2 text-sm text-ink-faint">{t('skills.catalog.empty')}</li> : null}
                </ul>
              </div>

              <div className={cx('flex min-h-0 min-w-0 flex-1 flex-col border-line', !focused && 'hidden md:flex')}>
                {focused ? <Button variant="ghost" className="shrink-0 self-start md:hidden" disabled={busy} onClick={() => { setSelected(null); setWanted(null) }}>{t('skills.catalog.back')}</Button> : null}
                {focused && current ? (
                  <SkillPreview
                    key={`${current.id}:${focused.path}:${destination?.value}`}
                    sourceId={current.id}
                    skill={focused}
                    scope={destination?.scope ?? scope}
                    projectId={destination?.projectId ?? null}
                    onInstalled={() => {
                      setCompleted((count) => count + 1)
                      setErrors((previous) => { const next = { ...previous }; delete next[focused.path]; return next })
                      setChecked((previous) => { const next = new Set(previous); next.delete(focused.path); return next })
                    }}
                    disabled={busy}
                    onBusy={setBusy}
                  />
                ) : (
                  <p className="m-auto px-6 py-8 text-center text-sm text-ink-faint">
                    {missing ? t('skills.catalog.missing', { name: wanted }) : t('skills.catalog.pick')}
                  </p>
                )}
              </div>
            </div>
          )}
          {fetched.length > 0 ? <footer className="shrink-0 border-t border-line p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
              <Select label={t('skills.field.destination')} value={destination?.value ?? ''} disabled={busy}
                onChange={(value) => { setTarget(value); setChecked(new Set()); setErrors({}); setCompleted(0) }}
                options={permissions.destinations.map((entry) => ({ value: entry.value, label: entry.label }))} />
              <Button disabled={busy || checked.size === 0 || !destination} onClick={() => void installSelected()}>
                {busy ? t('skills.catalog.installing') : t('skills.batch.install', { count: checked.size })}
              </Button>
            </div>
            {completed > 0 ? <p role="status" className="mt-2 text-sm text-positive">{t('skills.batch.completed', { count: completed })}</p> : null}
          </footer> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

/**
 * Le skill qu'un résultat de skills.sh désigne. L'annuaire le nomme comme son frontmatter,
 * et le catalogue aussi, sauf quand le `SKILL.md` n'en donne pas : le dossier sert alors.
 */
function findByName(skills: SourceSkillDto[], name: string): SourceSkillDto | null {
  return skills.find((skill) => skill.name === name) ?? skills.find((skill) => skill.path.split('/').pop() === name) ?? null
}

function CatalogBadges({ skill }: { skill: SourceSkillDto }) {
  const t = useTranslate()
  return (
    <>
      {skill.scripts ? <Badge tone="caution">{t('skills.badge.scripts')}</Badge> : null}
      {skill.installed.length > 0 ? (
        <Badge tone={skill.installed.some((entry) => entry.updateAvailable) ? 'accent' : 'positive'}>
          {skill.installed.some((entry) => entry.updateAvailable) ? t('skills.badge.update') : t('skills.catalog.installed')}
        </Badge>
      ) : null}
      {skill.problem ? <Badge tone="critical">{t(`skills.problem.${skill.problem}`)}</Badge> : null}
    </>
  )
}

function SkillPreview({
  sourceId,
  skill,
  scope,
  projectId,
  onInstalled,
  disabled,
  onBusy,
}: {
  sourceId: string
  skill: SourceSkillDto
  scope: LibrarySkillScope
  projectId: string | null
  onInstalled: () => void
  disabled: boolean
  onBusy: (busy: boolean) => void
}) {
  const t = useTranslate()
  const permissions = useSkillPermissions()
  const { data: preview, isLoading, error: previewError } = useSourcePreview(sourceId, skill.path)
  const install = useInstallSourceSkill()
  const destination = permissions.destinations.find((entry) => entry.scope === scope && entry.projectId === projectId)
  const [name, setName] = useState(skillNameSchema.safeParse(skill.name).success ? skill.name : '')

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h3 className="font-mono text-base font-semibold">{skill.name}</h3>
          <span className="font-mono text-xs text-ink-faint">{skill.path || '/'}</span>
        </div>
        {skill.scripts ? <div className="mb-3"><Banner tone="caution">{t('skills.compat.runs_scripts')}</Banner></div> : null}
        {skill.installed.length > 0 ? (
          <div className="mb-3">
            <Banner tone="info">
              {t('skills.catalog.alreadyInstalled', { names: skill.installed.map((entry) => entry.name).join(', ') })}
            </Banner>
          </div>
        ) : null}
        {previewError ? <Banner>{previewError.message}</Banner> : isLoading || !preview ? (
          <p className="text-sm text-ink-faint">{t('skills.files.loading')}</p>
        ) : (
          <>
            <pre className="rounded-md border border-line bg-sunken p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-ink-soft">
              {preview.main}
            </pre>
            <p className="mt-3 mb-1 text-xs font-semibold text-ink-soft">{t('skills.catalog.files', { count: preview.files.length })}</p>
            <ul className="font-mono text-xs text-ink-faint">
              {preview.files.map((file) => <li key={file}>{file}</li>)}
            </ul>
          </>
        )}
      </div>

      <footer className="flex shrink-0 flex-col gap-3 border-t border-line p-4">
        {permissions.destinations.length === 0 ? (
          <p className="text-sm text-ink-faint">{t('skills.catalog.noDestination')}</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <NameField value={name} onChange={setName} disabled={disabled} />
          </div>
        )}
        {install.error instanceof ApiRequestError ? <Banner>{install.error.message}</Banner> : null}
        <Button
          className="self-end"
          disabled={disabled || skill.installed.some((entry) => entry.scope === scope && entry.projectId === projectId && entry.name === name) || !destination || !skillNameSchema.safeParse(name).success || skill.problem === 'skill_unreadable' || install.isPending}
          onClick={() => {
            if (!destination) return
            onBusy(true)
            install.mutate(
              {
                sourceId,
                path: skill.path,
                scope: destination.scope,
                projectId: destination.projectId,
                ...(name !== skill.name ? { name } : {}),
              },
              { onSuccess: onInstalled, onSettled: () => onBusy(false) },
            )
          }}
        >
          {install.isPending ? t('skills.catalog.installing') : t('skills.catalog.install')}
        </Button>
      </footer>
    </div>
  )
}
