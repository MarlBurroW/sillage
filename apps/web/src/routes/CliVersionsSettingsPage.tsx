import { Download, RefreshCw } from 'lucide-react'
import { compareCliVersions, type AgentAvailabilityDto } from '@sillage/protocol'
import { AGENT_LABELS, AgentIcon } from '../components/AgentIcon'
import { AgentInstallProgress } from '../components/AgentInstallProgress'
import { Badge, Banner, Button } from '../components/ui'
import { cliNeedsUpdate, useAgentAvailability, useAgentInstall, useCancelAgentInstall, useRefreshAgentAvailability } from '../lib/agents'
import { useTranslate } from '../lib/i18n'
import { useInstance } from '../lib/instance'
import { useCurrentUser } from '../lib/session'
import { SectionHeader } from './SettingsPage'

export function CliVersionsSettingsPage() {
  const t = useTranslate()
  const { data, isPending, error } = useAgentAvailability()
  const refresh = useRefreshAgentAvailability()
  const { data: instance } = useInstance()
  const { data: user } = useCurrentUser()
  const failure = refresh.error ?? error

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <SectionHeader title={t('cliUpdates.title')} description={t(instance?.profile === 'desktop' ? 'cliUpdates.description.desktop' : 'cliUpdates.description.server')} />
      <div className="flex flex-col items-start justify-between gap-3 sm:flex-row">
        <p className="max-w-lg flex-1 text-sm text-ink-faint">{t('cliUpdates.explanation')}</p>
        <Button size="sm" variant="secondary" icon={<RefreshCw size={14} />} disabled={refresh.isPending || isPending} onClick={() => refresh.mutate()}>
          {t(refresh.isPending ? 'cliUpdates.checking' : 'cliUpdates.check')}
        </Button>
      </div>
      {!user?.isAdmin ? <Banner tone="caution">{t('cliUpdates.adminOnly')}</Banner> : null}
      {failure ? <Banner>{failure.message}</Banner> : null}
      {isPending ? <p role="status" className="text-sm text-ink-faint">{t('cliUpdates.checking')}</p> : null}
      <ul className="divide-y divide-line border-y border-line">
        {data?.agents.map((entry) => <CliRow key={entry.agent} entry={entry} canManage={user?.isAdmin === true} />)}
      </ul>
    </div>
  )
}

function CliRow({ entry, canManage }: { entry: AgentAvailabilityDto; canManage: boolean }) {
  const t = useTranslate()
  const label = AGENT_LABELS[entry.agent]
  const install = useAgentInstall(entry, label)
  const cancel = useCancelAgentInstall()
  const outdated = cliNeedsUpdate(entry)
  const newer = entry.version !== null && (compareCliVersions(entry.version, entry.preferredVersion) ?? 0) > 0
  const current = entry.installed && entry.version === entry.preferredVersion
  const status = !entry.enabled ? 'cliUpdates.disabled' : !entry.installed ? 'cliUpdates.missing'
    : current ? 'cliUpdates.current' : newer ? 'cliUpdates.newer' : outdated ? 'cliUpdates.available' : 'cliUpdates.unknown'
  const canInstall = canManage && entry.enabled && entry.installable !== false && !newer && (!current || install.failed)

  return (
    <li className="flex flex-col gap-3 py-5" aria-label={label}>
      <div className="flex flex-wrap items-center gap-3">
        <AgentIcon agent={entry.agent} size={22} />
        <h3 className="min-w-0 flex-1 text-sm font-semibold">{label}</h3>
        <Badge tone={outdated ? 'caution' : current ? 'positive' : 'neutral'}>{t(status)}</Badge>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 sm:pl-9">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
          <div><dt className="text-xs text-ink-faint">{t('cliUpdates.installed')}</dt><dd className="mt-1 tabular-nums">{entry.version ?? t(entry.installed ? 'cliUpdates.unknown' : 'cliUpdates.missing')}</dd></div>
          <div><dt className="text-xs text-ink-faint">{t('cliUpdates.recommended')}</dt><dd className="mt-1 tabular-nums">{entry.preferredVersion}</dd></div>
        </dl>
        {install.queued ? (
          canManage ? <Button size="sm" variant="ghost" disabled={cancel.isPending} onClick={() => cancel.mutate(entry.agent)}>{t('cliUpdates.cancel')}</Button> : null
        ) : !install.progress && canInstall ? (
          <Button size="sm" variant="secondary" icon={<Download size={14} />} disabled={install.busy} onClick={install.start}>
            {install.failed ? t('agent.install.retry') : t(outdated ? 'cliUpdates.update' : 'agent.install.action', { version: entry.preferredVersion })}
          </Button>
        ) : null}
      </div>
      {install.progress ? <AgentInstallProgress label={label} version={entry.preferredVersion} progress={install.progress} className="sm:pl-9" /> : null}
      {install.queued ? <p role="status" className="text-sm text-ink-soft sm:pl-9">{install.status}</p> : null}
      {install.failed ? <Banner>{install.status}</Banner> : null}
      {cancel.error ? <Banner>{cancel.error.message}</Banner> : null}
      {entry.enabled && entry.installable === false ? <p className="text-xs text-ink-faint sm:pl-9">{t('cliUpdates.custom')}</p> : null}
      {entry.path ? (
        <details className="text-xs text-ink-faint sm:ml-9">
          <summary className="w-fit cursor-pointer py-1 hover:text-ink">{t(entry.managed ? 'cliUpdates.managed' : 'cliUpdates.external')}</summary>
          <p className="mt-1 break-all font-mono">{entry.path}</p>
          {!entry.managed && entry.installable !== false ? <p className="mt-2">{t('cliUpdates.externalHint')}</p> : null}
        </details>
      ) : null}
    </li>
  )
}
