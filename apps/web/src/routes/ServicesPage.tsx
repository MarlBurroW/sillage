import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUpRight, Bot, Play, RefreshCw, RotateCw, Server, Square, SquareTerminal, Unplug, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { ServiceAppAction, ServiceAppDto, ServiceDto, ServicesDto } from '@sillage/protocol'
import { MobileNavigationButton } from '../components/MobileNavigation'
import { Badge, Banner, Button, EmptyState, IconButton, Select } from '../components/ui'
import { api } from '../lib/api'
import { formatBytes } from '../lib/attachments'
import { useTranslate, type MessageKey } from '../lib/i18n'

type Attributed = Pick<ServiceDto, 'projectId' | 'projectName' | 'conversationId' | 'conversationTitle' | 'origin'>

export function ServicesPage() {
  const t = useTranslate()
  const client = useQueryClient()
  const [project, setProject] = useState('all')
  const query = useQuery({
    queryKey: ['services'],
    queryFn: () => api.get<ServicesDto>('/api/services'),
    refetchInterval: 5000,
  })
  const stop = useMutation({
    mutationFn: (id: string) => api.post(`/api/services/${encodeURIComponent(id)}/stop`),
    onSuccess: () => { void client.invalidateQueries({ queryKey: ['services'] }) },
  })
  const control = useMutation({
    mutationFn: ({ id, action }: { id: string; action: ServiceAppAction }) =>
      api.post(`/api/services/apps/${encodeURIComponent(id)}/${action}`),
    onSuccess: () => { void client.invalidateQueries({ queryKey: ['services'] }) },
  })
  const scannedAt = query.data?.scannedAt ?? Date.now()
  const services = query.data?.services ?? []
  const apps = query.data?.apps ?? []
  // Le filtre de projet vaut pour toutes les listes : il se construit sur leur réunion.
  const owners = [...apps, ...services]
  const projects = [...new Map(owners.filter((entry) => entry.projectId)
    .map((entry) => [entry.projectId!, entry.projectName!])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]))
  const inProject = (entry: { projectId: string | null }) => project === 'all' || (entry.projectId ?? 'unknown') === project
  const options = [
    { value: 'all', label: t('services.allProjects') },
    ...projects.map(([value, label]) => ({ value, label })),
    ...(owners.some((entry) => !entry.projectId) ? [{ value: 'unknown', label: t('services.noProject') }] : []),
  ]
  // Un filtre reste effaçable quand le dernier service de ce projet vient de s'arrêter.
  if (!options.some((option) => option.value === project)) options.push({ value: project, label: t('services.previousProject') })

  const filteredApps = apps.filter(inProject)
  // Une commande suit son lanceur dans le filtre : c'est lui qui porte le projet à l'écran.
  const launchers = services.filter((entry) => entry.kind === 'launcher' && inProject(entry))
  const byLauncher = new Map<number, ServiceDto[]>()
  for (const entry of services) {
    if (entry.launcherPid === null) continue
    byLauncher.set(entry.launcherPid, [...(byLauncher.get(entry.launcherPid) ?? []), entry])
  }
  // Une commande dont le lanceur n'est pas visible garde sa place, sous son propre projet.
  const stray = services.filter((entry) => entry.kind === 'command' && entry.launcherPid !== null
    && !services.some((launcher) => launcher.pid === entry.launcherPid) && inProject(entry))
  const detached = services.filter((entry) => entry.kind === 'detached' && inProject(entry))
  const commands = launchers.flatMap((launcher) => (byLauncher.get(launcher.pid) ?? []).filter((entry) => entry.kind === 'command'))
  const total = filteredApps.length + commands.length + stray.length + detached.length
  const nothing = total === 0 && launchers.length === 0
  const busy = stop.isPending || control.isPending

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3 md:px-6">
        <MobileNavigationButton />
        <Server size={19} className="shrink-0 text-ink-faint" />
        <h1 className="text-base font-semibold">{t('services.title')}</h1>
        {query.data?.supported ? <Badge>{total}</Badge> : null}
        <div className="ml-auto">
          <IconButton label={t('services.refresh')} disabled={query.isFetching} onClick={() => { void query.refetch() }}>
            <RefreshCw size={17} />
          </IconButton>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto flex max-w-5xl flex-col gap-6">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
            <p className="max-w-xl text-sm text-ink-soft">{t('services.description')}</p>
            <Select value={project} onChange={setProject} options={options} placeholder={t('services.allProjects')} className="sm:w-56 sm:shrink-0" />
          </div>
          {query.error ? <Banner>{t('services.loadError')} {query.error.message}</Banner> : null}
          {stop.error ? <Banner>{stop.error.message}</Banner> : null}
          {stop.isSuccess ? <Banner tone="info">{t('services.stopRequested')}</Banner> : null}
          {control.error ? <Banner>{control.error.message}</Banner> : null}
          {control.isSuccess ? <Banner tone="info">{t('services.app.actionRequested')}</Banner> : null}
          {query.isPending ? <p role="status" className="text-sm text-ink-faint">{t('services.loading')}</p>
            : query.data && !query.data.supported ? <EmptyState icon={<Server size={22} />} title={t('services.unsupported')} />
              : query.data && nothing ? <EmptyState icon={<Server size={22} />} title={t('services.empty')} description={t('services.emptyHint')} />
                : query.data ? (
                  <>
                    <Section id="services-apps" title={t('services.apps.title')} description={t('services.apps.description')}>
                      {filteredApps.length ? (
                        <ul className="flex flex-col gap-2">
                          {filteredApps.map((app) => (
                            <AppRow key={app.id} app={app} scannedAt={scannedAt} busy={busy}
                              onAction={(action) => control.mutate({ id: app.id, action })} />
                          ))}
                        </ul>
                      ) : <p className="text-sm text-ink-faint">{t('services.apps.empty')}</p>}
                    </Section>
                    <Section id="services-launchers" title={t('services.launchers.title')} description={t('services.launchers.description')}>
                      {launchers.length || stray.length ? (
                        <div className="flex flex-col gap-4">
                          {launchers.map((launcher) => (
                            <LauncherGroup key={launcher.id} launcher={launcher} entries={byLauncher.get(launcher.pid) ?? []}
                              scannedAt={scannedAt} busy={busy} onStop={(id) => stop.mutate(id)} />
                          ))}
                          {stray.length ? (
                            <ul className="flex flex-col gap-2">
                              {stray.map((entry) => <ProcessRow key={entry.id} entry={entry} attributed scannedAt={scannedAt} busy={busy} onStop={(id) => stop.mutate(id)} />)}
                            </ul>
                          ) : null}
                        </div>
                      ) : <p className="text-sm text-ink-faint">{t('services.launchers.empty')}</p>}
                    </Section>
                    {detached.length ? (
                      <Section id="services-detached" title={t('services.detached.title')} description={t('services.detached.description')}>
                        <ul className="flex flex-col gap-2">
                          {detached.map((entry) => <ProcessRow key={entry.id} entry={entry} attributed scannedAt={scannedAt} busy={busy} onStop={(id) => stop.mutate(id)} />)}
                        </ul>
                      </Section>
                    ) : null}
                  </>
                ) : null}
          <details className="text-xs leading-relaxed text-ink-faint">
            <summary className="w-fit cursor-pointer hover:text-ink">{t('services.scopeTitle')}</summary>
            <p className="mt-2 max-w-2xl">{t('services.scope')}</p>
          </details>
        </div>
      </div>
    </div>
  )
}

function Section({ id, title, description, children }: { id: string; title: string; description: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id={id} className="text-sm font-semibold">{title}</h2>
        <p className="max-w-2xl text-xs text-ink-faint">{description}</p>
      </div>
      {children}
    </section>
  )
}

function useDuration(scannedAt: number) {
  const t = useTranslate()
  return (startedAt: number | null) => {
    if (startedAt === null) return null
    const minutes = Math.max(0, Math.floor((scannedAt - startedAt) / 60000))
    return minutes < 60 ? t('services.minutes', { count: minutes }) : t('services.hours', { count: Math.floor(minutes / 60) })
  }
}

/** Projet, puis conversation ou terminal d'origine, en une ligne. */
function Attribution({ entry }: { entry: Attributed }) {
  const t = useTranslate()
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
      {entry.projectId ? <Link to={`/p/${entry.projectId}`} className="font-medium text-ink-soft hover:text-accent">{entry.projectName}</Link>
        : <span className="text-ink-faint">{t('services.noProject')}</span>}
      {entry.conversationId ? (
        <>
          <span aria-hidden className="text-ink-faint">·</span>
          <Link to={`/p/${entry.projectId}/c/${entry.conversationId}`} className="flex min-w-0 items-center gap-1 text-accent hover:underline">
            <span className="truncate">{entry.conversationTitle || t('services.conversation')}</span><ArrowUpRight size={12} className="shrink-0" />
          </Link>
        </>
      ) : entry.origin === 'unknown' && !entry.projectId ? null : (
        <>
          <span aria-hidden className="text-ink-faint">·</span>
          <span className="text-ink-faint">{t(entry.origin === 'terminal' ? 'services.terminal' : entry.origin === 'agent' ? 'services.deletedConversation' : 'services.unknownOrigin')}</span>
        </>
      )}
    </span>
  )
}

/** Un agent ou un terminal, avec ce qu'il a lancé ; ses outils (serveurs MCP) tiennent en un mot. */
function LauncherGroup({ launcher, entries, scannedAt, busy, onStop }: {
  launcher: ServiceDto
  entries: ServiceDto[]
  scannedAt: number
  busy: boolean
  onStop: (id: string) => void
}) {
  const t = useTranslate()
  const duration = useDuration(scannedAt)
  const commands = entries.filter((entry) => entry.kind === 'command')
  const helpers = entries.filter((entry) => entry.kind === 'helper')
  const agent = launcher.origin === 'agent'
  const Icon = agent ? Bot : SquareTerminal
  const memory = launcher.memoryBytes + helpers.reduce((sum, helper) => sum + helper.memoryBytes, 0)
  const helperNames = helpers.map((helper) => helper.command ?? helper.name).join('\n')
  const kind = t(agent ? 'services.launcher.agent' : launcher.origin === 'terminal' ? 'services.launcher.terminal' : 'services.unknownOrigin')
  return (
    // Un repère en bordure gauche, à angles droits, relie le lanceur à ses commandes.
    <section aria-label={`${kind} ${launcher.conversationTitle ?? launcher.projectName ?? launcher.name}`} className="flex flex-col gap-2 border-l-2 border-line-strong pl-3 md:pl-4">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="flex items-center gap-1.5 text-ink-faint">
          <Icon size={15} className="shrink-0" />
          <span className="text-xs font-medium uppercase tracking-wide">{kind}</span>
        </span>
        <Attribution entry={launcher} />
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-faint">
          <span>{launcher.name} · {t('services.pid', { pid: launcher.pid })}</span>
          <span title={new Date(launcher.startedAt).toLocaleString()}>{duration(launcher.startedAt)}</span>
          <span>{formatBytes(memory)}</span>
          {helpers.length ? <span title={t('services.launcher.helpersHint', { names: helperNames })}>{t('services.launcher.helpers', { count: helpers.length })}</span> : null}
        </span>
      </div>
      {commands.length ? (
        <ul className="flex flex-col gap-2">
          {commands.map((entry) => (
            <ProcessRow key={entry.id} entry={entry} scannedAt={scannedAt} busy={busy} onStop={onStop}
              attributed={entry.conversationId !== launcher.conversationId || entry.projectId !== launcher.projectId} />
          ))}
        </ul>
      ) : <p className="text-xs text-ink-faint">{t('services.launcher.idle')}</p>}
    </section>
  )
}

/** Une commande et tout ce qui en descend, ou un processus détaché. */
function ProcessRow({ entry, attributed, scannedAt, busy, onStop }: {
  entry: ServiceDto
  attributed?: boolean
  scannedAt: number
  busy: boolean
  onStop: (id: string) => void
}) {
  const t = useTranslate()
  const duration = useDuration(scannedAt)
  const title = entry.command ?? entry.name
  const names = entry.processes.map((process) => process.count > 1 ? `${process.name} ×${process.count}` : process.name).join(', ')
  return (
    <li className="surface flex min-w-0 flex-col gap-2 rounded-lg border border-line p-3 md:p-4">
      <div className="flex min-w-0 flex-wrap items-start gap-2">
        {entry.kind === 'detached' ? <Unplug size={14} className="mt-1 shrink-0 text-ink-faint" aria-hidden />
          : <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-positive" />}
        <code className="min-w-0 flex-1 basis-64 break-all font-mono text-sm text-ink" title={title}>{title}</code>
        {entry.ports.length ? (
          <span className="flex flex-wrap gap-1" aria-label={t('services.ports')}>
            {entry.ports.map((port) => <Badge key={port} tone="accent">:{port}</Badge>)}
          </span>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-faint">
        {attributed ? <Attribution entry={entry} /> : null}
        <span>{t('services.pid', { pid: entry.pid })}</span>
        <span title={new Date(entry.startedAt).toLocaleString()}>{duration(entry.startedAt)}</span>
        <span>{formatBytes(entry.memoryBytes)}</span>
        {entry.processCount > 1 ? <span>{t('services.tree', { count: entry.processCount, names })}</span> : null}
        {entry.kind === 'detached' ? <span>{t(entry.stopsWithSillage ? 'services.stopsWithSillage' : 'services.shutdownUnknown')}</span> : null}
        {entry.cwd ? <span className="break-all font-mono">{entry.cwd}</span> : null}
        {entry.canStop ? (
          <Button className="ml-auto" variant="danger" size="sm" icon={<Square size={13} />} title={t('services.stopHint')} disabled={busy} onClick={() => onStop(entry.id)}>
            {t('services.stop')}
          </Button>
        ) : <span className="ml-auto" title={t('services.readOnlyHint')}>{t('services.readOnly')}</span>}
      </div>
    </li>
  )
}

/** Pastille et libellé de l'état systemd ; un état inconnu se montre tel quel. */
const APP_STATES: Record<string, { key: MessageKey; dot: string }> = {
  active: { key: 'services.app.state.active', dot: 'bg-positive' },
  activating: { key: 'services.app.state.activating', dot: 'bg-caution' },
  deactivating: { key: 'services.app.state.deactivating', dot: 'bg-caution' },
  reloading: { key: 'services.app.state.reloading', dot: 'bg-caution' },
  failed: { key: 'services.app.state.failed', dot: 'bg-critical' },
  inactive: { key: 'services.app.state.inactive', dot: 'bg-ink-faint' },
}

function AppRow({ app, scannedAt, busy, onAction }: {
  app: ServiceAppDto
  scannedAt: number
  busy: boolean
  onAction: (action: ServiceAppAction) => void
}) {
  const t = useTranslate()
  const duration = useDuration(scannedAt)
  const state = APP_STATES[app.state]
  const name = app.unit.replace(/^sillage-app-/, '').replace(/\.service$/, '')
  const manageable = app.canStop || app.canRestart || app.canReset
  const logs = `journalctl --user -u ${app.unit}`
  return (
    <li className="surface flex min-w-0 flex-col gap-2 rounded-lg border border-line p-3 md:p-4">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span aria-hidden className={`size-2 shrink-0 rounded-full ${state?.dot ?? 'bg-ink-faint'}`} />
        <h3 className="min-w-0 break-all font-medium" title={app.unit}>{name}</h3>
        <span className="text-xs text-ink-faint">{state ? t(state.key, { result: app.result }) : app.state}</span>
        {app.enabled ? <span title={t('services.app.enabledHint', { unit: app.unit })}><Badge tone="caution">{t('services.app.enabled')}</Badge></span> : null}
        {app.ports.length ? (
          <span className="ml-auto flex flex-wrap gap-1" aria-label={t('services.ports')}>
            {app.ports.map((port) => <Badge key={port} tone="accent">:{port}</Badge>)}
          </span>
        ) : null}
      </div>
      {app.command || app.description ? (
        <p className="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
          {app.command ? <code className="min-w-0 break-all font-mono text-ink" title={app.command}>{app.command}</code> : null}
          {app.description ? <span className="break-words text-xs text-ink-soft">{app.description}</span> : null}
        </p>
      ) : null}
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-faint">
        <Attribution entry={app} />
        {app.startedAt !== null ? <span title={new Date(app.startedAt).toLocaleString()}>{duration(app.startedAt)}</span> : null}
        {app.memoryBytes !== null ? <span>{formatBytes(app.memoryBytes)}</span> : null}
        {!app.enabled && app.transient ? <span>{t('services.app.transient')}</span> : null}
        {app.cwd ? <span className="break-all font-mono">{app.cwd}</span> : null}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2 border-t border-line pt-2 text-xs text-ink-faint">
        <span className="min-w-0 break-all font-mono">{t('services.app.logs', { command: logs })}</span>
        <span className="ml-auto flex flex-wrap gap-1">
          {app.canReset ? <Button variant="ghost" size="sm" icon={<X size={13} />} title={t('services.app.resetHint')} disabled={busy} onClick={() => onAction('reset')}>{t('services.app.reset')}</Button> : null}
          {app.canRestart ? (
            <Button variant="secondary" size="sm" icon={app.state === 'inactive' ? <Play size={13} /> : <RotateCw size={13} />} disabled={busy} onClick={() => onAction('restart')}>
              {t(app.state === 'inactive' ? 'services.app.start' : 'services.app.restart')}
            </Button>
          ) : null}
          {app.canStop ? <Button variant="danger" size="sm" icon={<Square size={13} />} disabled={busy} onClick={() => onAction('stop')}>{t('services.app.stop')}</Button> : null}
          {!manageable ? <span title={t('services.app.readOnlyHint')}>{t('services.readOnly')}</span> : null}
        </span>
      </div>
    </li>
  )
}
