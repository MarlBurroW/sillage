import * as Dialog from '@radix-ui/react-dialog'
import { Library, X } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
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
 * Le catalogue des sources : choisir un skill, le relire, l'installer.
 *
 * L'aperçu montre le `SKILL.md` brut, tel que le modèle le recevra, et la liste des
 * fichiers qui viendront avec : un skill tiers entre dans le contexte des agents et ses
 * scripts s'exécutent avec leurs droits. On l'installe en connaissance de cause.
 */
export function CatalogDialog({
  open,
  onClose,
  sourceId,
  scope,
  projectId,
}: {
  open: boolean
  onClose: () => void
  /** Source ouverte d'abord ; à défaut, la première récupérée. */
  sourceId?: string | null
  scope: LibrarySkillScope
  projectId: string | null
}) {
  const t = useTranslate()
  const { data } = useSkillSources()
  const fetched = (data?.sources ?? []).filter((source) => source.enabled && source.lastCommit !== null)
  const [chosen, setChosen] = useState<string | null>(sourceId ?? null)
  const current = fetched.find((source) => source.id === chosen) ?? fetched[0] ?? null
  const { data: catalog } = useSourceCatalog(open && current ? current.id : null)
  const [filter, setFilter] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const needle = filter.trim().toLowerCase()
  const skills = (catalog?.skills ?? []).filter(
    (skill) => !needle || skill.name.toLowerCase().includes(needle) || skill.description.toLowerCase().includes(needle),
  )
  const focused = skills.find((skill) => skill.path === selected) ?? null

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/35 backdrop-blur-sm" />
        <Dialog.Content
          aria-describedby={undefined}
          className="surface fixed inset-x-0 bottom-0 z-50 flex h-[92dvh] flex-col rounded-t-2xl border border-line shadow-pop sm:inset-x-auto sm:top-1/2 sm:bottom-auto sm:left-1/2 sm:h-[min(80dvh,760px)] sm:w-[min(1040px,calc(100vw-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl"
        >
          <header className="flex items-center gap-3 border-b border-line px-5 py-3">
            <Dialog.Title className="flex-1 text-lg font-semibold">{t('skills.catalog.title')}</Dialog.Title>
            <IconButton label={t('skills.dialog.close')} onClick={onClose}>
              <X size={18} />
            </IconButton>
          </header>

          {fetched.length === 0 ? (
            <EmptyState icon={<Library size={22} />} title={t('skills.catalog.noSource')} description={t('skills.catalog.noSource.hint')} />
          ) : (
            // Au doigt, la fenêtre défile d'un bloc : des zones défilantes empilées ne
            // laissaient plus de place au SKILL.md, qu'il faut pourtant relire avant
            // d'installer. Sur grand écran, liste et aperçu défilent chacun de leur côté.
            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto md:flex-row md:overflow-hidden">
              <div className="flex flex-col gap-3 border-line p-4 md:min-h-0 md:w-80 md:shrink-0 md:border-r">
                <Select
                  label={t('skills.catalog.source')}
                  value={current?.id ?? ''}
                  onChange={(id) => { setChosen(id); setSelected(null) }}
                  options={fetched.map((source) => ({
                    value: source.id,
                    label: `${source.name} · ${shortCommit(source.lastCommit)}`,
                  }))}
                />
                <input
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder={t('skills.catalog.filter')}
                  aria-label={t('skills.catalog.filter')}
                  className="tap-target rounded-md border border-line bg-sunken px-3 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-accent"
                />
                <ul className="-mx-1 flex max-h-56 flex-col gap-0.5 overflow-y-auto md:max-h-none md:min-h-0 md:flex-1">
                  {skills.map((skill) => (
                    <li key={skill.path}>
                      <button
                        type="button"
                        onClick={() => setSelected(skill.path)}
                        className={cx(
                          'flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 text-left transition-colors',
                          focused?.path === skill.path ? 'bg-accent-wash' : 'hover:bg-surface-high',
                        )}
                      >
                        <span className="flex flex-wrap items-center gap-1.5">
                          <span className="font-mono text-sm font-medium text-ink">{skill.name}</span>
                          <CatalogBadges skill={skill} />
                        </span>
                        <span className="line-clamp-2 text-xs text-ink-faint">{skill.description}</span>
                      </button>
                    </li>
                  ))}
                  {skills.length === 0 ? <li className="px-2.5 py-2 text-sm text-ink-faint">{t('skills.catalog.empty')}</li> : null}
                </ul>
              </div>

              <div className="flex flex-col border-t border-line md:min-h-0 md:flex-1 md:border-t-0">
                {focused && current ? (
                  <SkillPreview
                    key={`${current.id}:${focused.path}`}
                    sourceId={current.id}
                    skill={focused}
                    scope={scope}
                    projectId={projectId}
                    onInstalled={onClose}
                  />
                ) : (
                  <p className="m-auto px-6 py-8 text-center text-sm text-ink-faint">{t('skills.catalog.pick')}</p>
                )}
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
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
}: {
  sourceId: string
  skill: SourceSkillDto
  scope: LibrarySkillScope
  projectId: string | null
  onInstalled: () => void
}) {
  const t = useTranslate()
  const navigate = useNavigate()
  const permissions = useSkillPermissions()
  const { data: preview, isLoading } = useSourcePreview(sourceId, skill.path)
  const install = useInstallSourceSkill()
  const initial = permissions.destinations.find((entry) => entry.scope === scope && entry.projectId === projectId)
  const [target, setTarget] = useState(initial?.value ?? permissions.destinations[0]?.value ?? '')
  const destination = permissions.destinations.find((entry) => entry.value === target)
  const [name, setName] = useState(skillNameSchema.safeParse(skill.name).success ? skill.name : '')

  return (
    <div className="flex flex-col md:min-h-0 md:flex-1">
      <div className="p-4 md:min-h-0 md:flex-1 md:overflow-y-auto">
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
        {isLoading || !preview ? (
          <p className="text-sm text-ink-faint">{t('skills.files.loading')}</p>
        ) : (
          <>
            <pre className="rounded-md border border-line bg-sunken p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-ink-soft">
              {preview.main}
            </pre>
            <p className="mt-3 mb-1 text-xs font-semibold text-ink-soft">{t('skills.catalog.files', { count: preview.files.length })}</p>
            <ul className="font-mono text-xs text-ink-faint">
              {preview.files.map((file) => <li key={file}>{file}</li>)}
            </ul>
          </>
        )}
      </div>

      <footer className="flex flex-col gap-3 border-t border-line p-4">
        {permissions.destinations.length === 0 ? (
          <p className="text-sm text-ink-faint">{t('skills.catalog.noDestination')}</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Select
              label={t('skills.field.destination')}
              value={target}
              onChange={setTarget}
              options={permissions.destinations.map((entry) => ({ value: entry.value, label: entry.label }))}
            />
            <NameField value={name} onChange={setName} />
          </div>
        )}
        {install.error instanceof ApiRequestError ? <Banner>{install.error.message}</Banner> : null}
        <Button
          className="self-end"
          disabled={!destination || !skillNameSchema.safeParse(name).success || skill.problem === 'skill_unreadable' || install.isPending}
          onClick={() =>
            destination &&
            install.mutate(
              {
                sourceId,
                path: skill.path,
                scope: destination.scope,
                projectId: destination.projectId,
                ...(name !== skill.name ? { name } : {}),
              },
              { onSuccess: (created) => { onInstalled(); navigate(`/skills/${created.id}`) } },
            )
          }
        >
          {install.isPending ? t('skills.catalog.installing') : t('skills.catalog.install')}
        </Button>
      </footer>
    </div>
  )
}
