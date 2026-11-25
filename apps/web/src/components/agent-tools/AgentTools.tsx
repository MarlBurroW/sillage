import { Bot, CalendarClock, Download, FileText, FolderCog, GitBranch, Globe, History, ShieldCheck, SquareKanban, Wrench, Zap } from 'lucide-react'
import type { ReactNode } from 'react'
import { AGENT_TOOL_DEFAULTS, AGENT_TOOL_FAMILIES, SILLAGE_TOOL_FAMILIES, resolveAgentTools, type AgentToolFamily, type AgentToolSettings } from '@sillage/protocol'
import { Banner, Button, Card, CardBody, CardHeader, EmptyState, Select, Switch } from '../ui'
import { useBrowserStatus, useInstallBrowser } from '../../lib/browsers'
import { SectionHeader } from '../../routes/SettingsPage'
import { ApiRequestError } from '../../lib/api'
import { useAppSettings, useUpdateAppSettings } from '../../lib/app-settings'
import { useUpdateProject } from '../../lib/projects'
import { useTranslate } from '../../lib/i18n'
import { useCurrentUser } from '../../lib/session'

const FAMILY_ICONS: Record<AgentToolFamily, ReactNode> = {
  history: <History size={16} />,
  board: <SquareKanban size={16} />,
  coordination: <Bot size={16} />,
  automations: <CalendarClock size={16} />,
  worktrees: <GitBranch size={16} />,
  actions: <Zap size={16} />,
  instructions: <FileText size={16} />,
  project: <FolderCog size={16} />,
  browser: <Globe size={16} />,
}

/** Built into the `sillage` server, then extra tools Sillage adds as their own servers. */
const GROUPS: { key: 'builtin' | 'extra'; families: AgentToolFamily[] }[] = [
  { key: 'builtin', families: AGENT_TOOL_FAMILIES.filter((family) => family !== 'browser') },
  { key: 'extra', families: ['browser'] },
]

/** One row per family; each screen decides what the control does. A wide control (`stack`) goes under the text on phones. */
function FamilyRow({ family, stack = false, children }: { family: AgentToolFamily; stack?: boolean; children: ReactNode }) {
  const t = useTranslate()
  const count = family === 'browser' ? null : SILLAGE_TOOL_FAMILIES[family].length
  return (
    <div className={stack ? 'grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 sm:flex' : 'flex items-center gap-3'}>
      <span className="shrink-0 text-ink-faint">{FAMILY_ICONS[family]}</span>
      <div className="min-w-0 flex-1">
        <p className="text-sm">
          {t(`agentTools.family.${family}`)}
          {count ? <span className="ml-1.5 text-xs text-ink-faint">{t('agentTools.toolCount', { count })}</span> : null}
        </p>
        <p className="text-xs text-ink-faint">{t(`agentTools.family.${family}.description`)}</p>
      </div>
      {children}
    </div>
  )
}

function GroupHeading({ group }: { group: 'builtin' | 'extra' | 'scope' }) {
  const t = useTranslate()
  return <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{t(`agentTools.group.${group}`)}</h3>
}

/**
 * The instance's switches, one per family: shared by the settings page and the first-run step, so
 * both write the same setting the same way.
 */
export function InstanceAgentTools() {
  const t = useTranslate()
  const { data: settings } = useAppSettings()
  const update = useUpdateAppSettings()
  const stored = settings?.agentTools ?? {}
  const write = (family: AgentToolFamily, enabled: boolean) => {
    // The body replaces the stored set: send every explicit choice, not just this one.
    const next: AgentToolSettings = { ...stored, [family]: enabled }
    update.mutate({ agentTools: next })
  }
  return (
    <div className="flex flex-col gap-4">
      {GROUPS.map(({ key, families }) => (
        <div key={key} className="flex flex-col gap-3">
          <GroupHeading group={key} />
          {families.map((family) => (
            <FamilyRow key={family} family={family}>
              <Switch
                checked={stored[family] ?? AGENT_TOOL_DEFAULTS[family]}
                label={t(`agentTools.family.${family}`)}
                disabled={!settings || update.isPending}
                onCheckedChange={(checked) => write(family, checked)}
              />
            </FamilyRow>
          ))}
        </div>
      ))}
      {update.error instanceof ApiRequestError ? <Banner tone="critical">{update.error.message}</Banner> : null}
    </div>
  )
}

/** Instance defaults, admin only: they apply to every project that does not choose. */
export function AgentToolsSettingsPage() {
  const t = useTranslate()
  const { data: me } = useCurrentUser()

  if (me?.isAdmin !== true) {
    return <EmptyState icon={<ShieldCheck size={22} />} title={t('agentTools.adminOnly.title')} description={t('agentTools.adminOnly.description')} />
  }

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader title={t('agentTools.section.title')} description={t('agentTools.section.description')} />
      <Card>
        <CardHeader title={t('agentTools.instance.title')} icon={<Wrench size={16} />} />
        <CardBody>
          <InstanceAgentTools />
        </CardBody>
      </Card>
      <BrowserInstallCard />
      <Banner tone="info">{t('agentTools.instance.nextLaunch')}</Banner>
    </div>
  )
}

/**
 * What the browser family needs on this machine. Sessions only receive the browser tools once both
 * parts are there, so the switch alone never promises tools that would fail.
 */
function BrowserInstallCard() {
  const t = useTranslate()
  const { data: status } = useBrowserStatus()
  const install = useInstallBrowser()
  if (!status) return null
  const engineLabel = status.engine ? t(`agentTools.browser.engine.${status.engine.source}`) : t('agentTools.browser.engine.none')
  return (
    <Card>
      <CardHeader title={t('agentTools.browser.title')} icon={<Globe size={16} />} />
      <CardBody className="flex flex-col gap-3 text-sm">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
          <dt className="text-ink-faint">{t('agentTools.browser.mcp')}</dt>
          <dd>{status.mcp.installed ? `Playwright MCP ${status.mcp.version}` : t('agentTools.browser.missing')}</dd>
          <dt className="text-ink-faint">{t('agentTools.browser.engine')}</dt>
          <dd className="min-w-0">
            <span>{engineLabel}</span>
            {status.engine ? <span className="block truncate font-mono text-xs text-ink-faint" title={status.engine.path}>{status.engine.path}</span> : null}
          </dd>
        </dl>
        {status.installing ? <Banner tone="info">{t('agentTools.browser.installing', { step: status.progress ?? '…' })}</Banner> : null}
        {status.error ? <Banner tone="critical">{status.error}</Banner> : null}
        {status.ready ? (
          <p className="text-xs text-positive">{t('agentTools.browser.ready')}</p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button icon={<Download size={15} />} disabled={status.installing || install.isPending} onClick={() => install.mutate()}>
              {t('agentTools.browser.install')}
            </Button>
            <span className="text-xs text-ink-faint">{t(status.engine ? 'agentTools.browser.install.hintMcp' : 'agentTools.browser.install.hintEngine')}</span>
          </div>
        )}
      </CardBody>
    </Card>
  )
}

type Choice = 'inherit' | 'on' | 'off'

/**
 * Project override, written by the owner. A three-way choice rather than a switch: following the
 * instance is a choice of its own, so an admin changing the default still reaches this project.
 */
export function ProjectAgentTools({ projectId, overrides, crossProjects, isOwner }: { projectId: string; overrides: AgentToolSettings; crossProjects: boolean; isOwner: boolean }) {
  const t = useTranslate()
  const { data: settings } = useAppSettings()
  const update = useUpdateProject()
  const instance = resolveAgentTools(settings?.agentTools ?? {}, null)

  return (
    <Card>
      <CardHeader title={t('agentTools.project.title')} icon={<Wrench size={16} />} />
      <CardBody className="flex flex-col gap-4">
        <p className="text-xs text-ink-faint">{t('agentTools.project.description')}</p>
        {GROUPS.map(({ key, families }) => (
          <div key={key} className="flex flex-col gap-3">
            <GroupHeading group={key} />
            {families.map((family) => {
              const value: Choice = overrides[family] === undefined ? 'inherit' : overrides[family] ? 'on' : 'off'
              return (
                <FamilyRow key={family} family={family} stack>
                  <Select<Choice>
                    className="col-start-2 w-full shrink-0 sm:w-52"
                    placeholder={t(`agentTools.family.${family}`)}
                    value={value}
                    disabled={!settings || !isOwner || update.isPending}
                    onChange={(choice) => update.mutate({ id: projectId, agentTools: { [family]: choice === 'inherit' ? null : choice === 'on' } })}
                    options={[
                      { value: 'inherit', label: t(instance[family] ? 'agentTools.project.inherit.on' : 'agentTools.project.inherit.off') },
                      { value: 'on', label: t('agentTools.project.on') },
                      { value: 'off', label: t('agentTools.project.off') },
                    ]}
                  />
                </FamilyRow>
              )
            })}
          </div>
        ))}
        {/* Not a family but the reach of several: the same tools, aimed at the account's other projects. */}
        <div className="flex flex-col gap-3 border-t border-line pt-4">
          <GroupHeading group="scope" />
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm">{t('project.settings.crossProjects')}</p>
              <p className="text-xs text-ink-faint">{t('project.settings.crossProjects.hint')}</p>
            </div>
            <Switch
              checked={crossProjects}
              label={t('project.settings.crossProjects')}
              disabled={!isOwner || update.isPending}
              onCheckedChange={(checked) => update.mutate({ id: projectId, crossProjects: checked })}
            />
          </div>
        </div>
        {update.error instanceof ApiRequestError ? <Banner tone="critical">{update.error.message}</Banner> : null}
      </CardBody>
    </Card>
  )
}
