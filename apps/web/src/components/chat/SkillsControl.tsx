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
    <SettingsSurface label={t('composer.skills.title')} inputRef={inputRef} disabled={false}
      trigger={<button type="button" aria-label={t('composer.skills.title')} title={t('composer.skills.title')}
        className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs text-ink-faint hover:bg-surface-high hover:text-ink md:min-h-8 pointer-coarse:min-h-11">
        <BookOpen size={14} /><span>{t('composer.skills.title')}</span>
      </button>}
    >
      {(close) => <SkillsInventory {...props} onClose={close} />}
    </SettingsSurface>
  )
}

function SkillsInventory({ projectId, config, skills, commands, onClose }: Omit<SkillsControlProps, 'inputRef'> & { onClose: () => void }) {
  const t = useTranslate()
  const [search, setSearch] = useState('')
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
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4">
      <label className="mb-4 flex items-center gap-2 rounded-md border border-line bg-sunken px-3">
        <Search size={15} className="shrink-0 text-ink-faint" />
        <input value={search} onChange={(event) => setSearch(event.target.value)} aria-label={t('composer.skills.search')}
          placeholder={t('composer.skills.search')} className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none" />
      </label>
      <section>
        <h3 className="text-xs font-semibold text-ink-soft">{t('composer.skills.configured')}</h3>
        <p className="mt-1 text-xs text-ink-faint">{t('composer.skills.configuredHint')}</p>
        {library.isPending ? <p role="status" className="py-3 text-sm text-ink-faint">{t('composer.skills.loading')}</p> : null}
        {library.isError ? <p role="alert" className="py-3 text-sm text-critical">{t('composer.skills.error')}</p> : null}
        {!library.isPending && !library.isError && !libraryEnabled ? <p className="py-3 text-sm text-ink-faint">{t('composer.skills.disabled')}</p> : null}
        {libraryEnabled && visibleLibrary.map((skill) => <div key={skill.id} className="border-b border-line py-3 last:border-0">
          <div className="flex items-baseline justify-between gap-3">
            <span className="break-words text-sm font-medium">{skill.name}</span>
            <span className="shrink-0 text-xs text-ink-faint">{t(skill.scope === 'project' ? 'composer.skills.project' : 'composer.skills.global')}</span>
          </div>
          <p className="mt-1 break-words text-xs text-ink-faint">{skill.description}</p>
        </div>)}
        {libraryEnabled && visibleLibrary.length === 0 ? <p className="py-3 text-sm text-ink-faint">{t('composer.skills.empty')}</p> : null}
      </section>
      <section className="mt-4 border-t border-line pt-4">
        <h3 className="text-xs font-semibold text-ink-soft">{t(config.agent === 'claude' ? 'composer.skills.commands' : 'composer.skills.reported')}</h3>
        <p className="mt-1 text-xs text-ink-faint">{t(config.agent === 'claude' ? 'composer.skills.commandsHint' : 'composer.skills.reportedHint')}</p>
        {visibleReported.map((skill) => <div key={skill.name} className="border-b border-line py-3 last:border-0">
          <p className="break-words text-sm font-medium">{skill.name}</p>
          <p className="mt-1 break-words text-xs text-ink-faint">{skill.description}</p>
        </div>)}
        {visibleReported.length === 0 ? <p className="py-3 text-sm text-ink-faint">{t(reported.length === 0 ? 'composer.skills.notReported' : 'composer.skills.empty')}</p> : null}
      </section>
      <Link to="/settings/skills" onClick={onClose} className="mt-3 flex min-h-11 items-center text-sm text-accent">{t('composer.skills.manage')}</Link>
    </div>
  </>
}
