import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowUpRight, RefreshCw, Server, Square } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { ServicesDto } from '@sillage/protocol'
import { MobileNavigationButton } from '../components/MobileNavigation'
import { Badge, Banner, Button, EmptyState, IconButton, Select } from '../components/ui'
import { api } from '../lib/api'
import { formatBytes } from '../lib/attachments'
import { useTranslate } from '../lib/i18n'

export function ServicesPage() {
  const t = useTranslate()
  const client = useQueryClient()
  const [project, setProject] = useState('all')
  const [showLaunchers, setShowLaunchers] = useState(false)
  const query = useQuery({
    queryKey: ['services'],
    queryFn: () => api.get<ServicesDto>('/api/services'),
    refetchInterval: 5000,
  })
  const stop = useMutation({
    mutationFn: (id: string) => api.post(`/api/services/${encodeURIComponent(id)}/stop`),
    onSuccess: () => { void client.invalidateQueries({ queryKey: ['services'] }) },
  })
  const services = (query.data?.services ?? []).filter((service) => showLaunchers || !service.launcher)
  const projects = [...new Map(services.filter((service) => service.projectId)
    .map((service) => [service.projectId!, service.projectName!])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1]))
  const filtered = services.filter((service) => project === 'all' || (service.projectId ?? 'unknown') === project)
  const options = [
    { value: 'all', label: t('services.allProjects') },
    ...projects.map(([value, label]) => ({ value, label })),
    ...(services.some((service) => !service.projectId) ? [{ value: 'unknown', label: t('services.noProject') }] : []),
  ]
  // Un filtre reste effaçable quand le dernier service de ce projet vient de s'arrêter.
  if (!options.some((option) => option.value === project)) options.push({ value: project, label: t('services.previousProject') })

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-line px-4 py-3 md:px-6">
        <MobileNavigationButton />
        <Server size={19} className="shrink-0 text-ink-faint" />
        <h1 className="text-base font-semibold">{t('services.title')}</h1>
        {query.data?.supported ? <Badge>{services.length}</Badge> : null}
        <div className="ml-auto">
          <IconButton label={t('services.refresh')} disabled={query.isFetching} onClick={() => { void query.refetch() }}>
            <RefreshCw size={17} />
          </IconButton>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 md:p-6">
        <div className="mx-auto flex max-w-5xl flex-col gap-5">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
            <p className="max-w-xl text-sm text-ink-soft">{t('services.description')}</p>
            <Select value={project} onChange={setProject} options={options} placeholder={t('services.allProjects')} className="sm:w-56 sm:shrink-0" />
          </div>
          <label className="flex w-fit items-center gap-2 text-sm text-ink-faint">
            <input type="checkbox" checked={showLaunchers} onChange={(event) => setShowLaunchers(event.target.checked)} />
            {t('services.showLaunchers')}
          </label>
          {query.error ? <Banner>{t('services.loadError')} {query.error.message}</Banner> : null}
          {stop.error ? <Banner>{stop.error.message}</Banner> : null}
          {stop.isSuccess ? <Banner tone="info">{t('services.stopRequested')}</Banner> : null}
          {query.isPending ? <p role="status" className="text-sm text-ink-faint">{t('services.loading')}</p>
            : query.data && !query.data.supported ? <EmptyState icon={<Server size={22} />} title={t('services.unsupported')} />
              : query.data && !filtered.length ? <EmptyState icon={<Server size={22} />} title={t('services.empty')} description={t('services.emptyHint')} />
                : <ul className="grid grid-cols-1 gap-3 xl:grid-cols-2">
                  {filtered.map((service) => {
                    const minutes = Math.max(0, Math.floor(((query.data?.scannedAt ?? service.startedAt) - service.startedAt) / 60000))
                    const duration = minutes < 60 ? t('services.minutes', { count: minutes }) : t('services.hours', { count: Math.floor(minutes / 60) })
                    return (
                      <li key={service.id} className="surface flex min-w-0 flex-col gap-3 rounded-lg border border-line p-4">
                        <div className="flex flex-wrap items-center gap-2">
                          <span aria-hidden className="size-2 shrink-0 rounded-full bg-positive" />
                          <h2 className="min-w-0 break-all font-medium">{service.name}</h2>
                          <span className="text-xs text-ink-faint">PID {service.pid}</span>
                          <span className="ml-auto flex flex-wrap gap-1" aria-label={t('services.ports')}>
                            {service.ports.map((port) => <Badge key={port}>:{port}</Badge>)}
                          </span>
                        </div>
                        <div className="flex flex-col gap-1 text-xs text-ink-soft">
                          <span>{t(service.relation === 'service-group' ? 'services.serviceGroup' : 'services.descendant')}</span>
                          <span>{t('services.parent', { name: service.parentName ?? '—', pid: service.parentPid })}</span>
                          <span className="text-ink-faint">{t(service.stopsWithSillage ? 'services.stopsWithSillage' : 'services.shutdownUnknown')}</span>
                        </div>
                        <div className="flex min-w-0 flex-col gap-1 text-sm">
                          {service.projectId ? <Link to={`/p/${service.projectId}`} className="w-fit font-medium text-ink-soft hover:text-accent">{service.projectName}</Link>
                            : <span className="text-ink-faint">{t('services.noProject')}</span>}
                          {service.conversationId ? (
                            <Link to={`/p/${service.projectId}/c/${service.conversationId}`} className="flex min-w-0 items-center gap-1 text-accent hover:underline">
                              <span className="truncate">{service.conversationTitle || t('services.conversation')}</span><ArrowUpRight size={14} className="shrink-0" />
                            </Link>
                          ) : <span className="text-ink-faint">{t(service.origin === 'terminal' ? 'services.terminal' : service.origin === 'agent' ? 'services.deletedConversation' : 'services.unknownOrigin')}</span>}
                          {service.cwd ? <p className="mt-1 break-all font-mono text-xs text-ink-faint">{service.cwd}</p> : null}
                        </div>
                        <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-line pt-3 text-xs text-ink-faint">
                          <span title={new Date(service.startedAt).toLocaleString()}>{duration}</span>
                          <span aria-hidden>·</span><span>{formatBytes(service.memoryBytes)}</span>
                          {service.canStop ? <Button className="ml-auto" variant="danger" size="sm" icon={<Square size={13} />} disabled={stop.isPending} onClick={() => stop.mutate(service.id)}>{t('services.stop')}</Button>
                            : <span className="ml-auto" title={t(service.launcher ? 'services.launcherHint' : 'services.readOnlyHint')}>{t(service.launcher ? 'services.launcher' : 'services.readOnly')}</span>}
                        </div>
                      </li>
                    )
                  })}
                </ul>}
          <details className="text-xs leading-relaxed text-ink-faint">
            <summary className="w-fit cursor-pointer hover:text-ink">{t('services.scopeTitle')}</summary>
            <p className="mt-2 max-w-2xl">{t('services.scope')}</p>
          </details>
        </div>
      </div>
    </div>
  )
}
