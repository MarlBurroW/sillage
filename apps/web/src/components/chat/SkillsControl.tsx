import { TooltipButton } from '../ui/Tooltip'
import { BookOpen, Search } from 'lucide-react'
import { useState, type RefObject } from 'react'
import { Link } from 'react-router-dom'
import type { AgentConfig, AgentSkillDto, SlashCommandDto } from '@sillage/protocol'
import { useTranslate } from '../../lib/i18n'
import { useSkillLibrary } from '../../lib/skill-library'
import { SettingsSurface } from './ComposerSettings'
import { SettingsHeading } from './SettingsPanel'

interface SkillsControlProps {
  projectId?: string
  config: AgentConfig
  skills: AgentSkillDto[]
  commands: SlashCommandDto[]
  inputRef: RefObject<HTMLTextAreaElement | null>
}

/** Le catalogue configuré ne prouve pas que le CLI l'a déjà chargé. */
export function SkillsControl({ inputRef, ...props }: SkillsControlProps) {
  const t = useTranslate()
  return (
    <SettingsSurface label={t('composer.skills.title')} inputRef={inputRef} disabled={false} spacious
      trigger={<TooltipButton type="button" aria-label={t('composer.skills.title')} title={t('composer.skills.title')}
        className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-ink-faint hover:bg-surface-high hover:text-ink md:min-h-8 pointer-coarse:min-h-11">
        <BookOpen size={14} /><span>{t('composer.skills.title')}</span>
      </TooltipButton>}
    >
      {(close) => <SkillsInventory {...props} onClose={close} />}
    </SettingsSurface>
  )
}

function SkillsInventory({ projectId, config, skills, commands, onClose }: Omit<SkillsControlProps, 'inputRef'> & { onClose: () => void }) {
  const t = useTranslate()
  const [search, setSearch] = useState('')
  const [view, setView] = useState<'library' | 'reported'>('library')
  const library = useSkillLibrary(projectId ?? null)
  const configured = (library.data?.skills ?? []).filter((skill) => skill.enabled && !skill.problem)
  const libraryEnabled = config.skillLibrary && library.data?.enabled === true
  // Claude ne distingue pas les skills des commandes dans son inventaire public.
  const reported = config.agent === 'claude' ? commands : skills
  const matches = (item: { name: string; description: string }) =>
    (item.name + ' ' + item.description).toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())
  const visibleLibrary = configured.filter(matches)
  const visibleReported = reported.filter(matches)

  return <>
    <SettingsHeading title={t('composer.skills.title')} onClose={onClose} />
    <div className="shrink-0 border-b border-line px-4 pb-3">
      <Link to="/settings/skills" onClick={onClose} className="mb-3 flex min-h-11 items-center gap-2 text-sm text-accent"><BookOpen size={16} />{t('composer.skills.manage')}</Link>
      <label className="flex items-center gap-2 rounded-md border border-line bg-sunken px-3">
        <Search size={15} className="shrink-0 text-ink-faint" />
        <input value={search} onChange={(event) => setSearch(event.target.value)} aria-label={t('composer.skills.search')}
          placeholder={t('composer.skills.search')} className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none" />
      </label>
      <div className="mt-3 flex gap-2" role="group" aria-label={t('composer.skills.title')}>
        {(['library', 'reported'] as const).map((key) => <button key={key} type="button" aria-pressed={view === key} onClick={() => setView(key)}
          className={`min-h-11 flex-1 border-b-2 px-2 text-sm ${view === key ? 'border-accent text-ink' : 'border-transparent text-ink-faint hover:text-ink'}`}>
          {t(key === 'library' ? 'composer.skills.configured' : 'composer.skills.session')} <span className="text-ink-faint">({key === 'library' ? visibleLibrary.length : visibleReported.length})</span>
        </button>)}
      </div>
    </div>
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
      {view === 'library' ? <section>
        <p className="py-3 text-xs text-ink-faint">{t('composer.skills.configuredHint')}</p>
        {library.isPending ? <p role="status" className="py-3 text-sm text-ink-faint">{t('composer.skills.loading')}</p> : null}
        {library.isError ? <p role="alert" className="py-3 text-sm text-critical">{t('composer.skills.error')}</p> : null}
        {!library.isPending && !library.isError && !libraryEnabled ? <p className="py-3 text-sm text-ink-faint">{t('composer.skills.disabled')}</p> : null}
        {libraryEnabled && visibleLibrary.map((skill) => <InventoryRow key={skill.id} name={skill.name} description={skill.description}
          scope={t(skill.scope === 'project' ? 'composer.skills.project' : 'composer.skills.global')} />)}
        {libraryEnabled && visibleLibrary.length === 0 ? <p className="py-3 text-sm text-ink-faint">{t('composer.skills.empty')}</p> : null}
      </section> : <section>
        <h3 className="pt-3 text-xs font-semibold text-ink-soft">{t(config.agent === 'claude' ? 'composer.skills.commands' : 'composer.skills.reported')}</h3>
        <p className="py-3 text-xs text-ink-faint">{t(config.agent === 'claude' ? 'composer.skills.commandsHint' : 'composer.skills.reportedHint')}</p>
        {visibleReported.map((skill) => <InventoryRow key={skill.name} name={skill.name} description={skill.description} />)}
        {visibleReported.length === 0 ? <p className="py-3 text-sm text-ink-faint">{t(reported.length === 0 ? 'composer.skills.notReported' : 'composer.skills.empty')}</p> : null}
      </section>}
    </div>
  </>
}

/** Une description longue reste consultable sans allonger tout l'inventaire. */
function InventoryRow({ name, description, scope }: { name: string; description: string; scope?: string }) {
  return <details className="group border-b border-line py-3 last:border-0">
    <summary className="cursor-pointer rounded-sm outline-offset-4 focus-visible:outline-accent">
      <span className="ml-1 break-words text-sm font-medium">{name}</span>
      {scope ? <span className="float-right ml-3 text-xs text-ink-faint">{scope}</span> : null}
      <span className="mt-1 line-clamp-2 text-xs text-ink-faint group-open:hidden">{description}</span>
    </summary>
    <p className="mt-2 whitespace-pre-wrap break-words text-sm text-ink-soft">{description}</p>
  </details>
}
