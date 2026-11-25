import { Copy, ExternalLink, MonitorPlay, RotateCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { PreviewTargetDto } from '@sillage/protocol'
import { useOpenPreview, usePreviews } from '../../lib/previews'
import { useTranslate } from '../../lib/i18n'
import { useCurrentUser } from '../../lib/session'
import { PanelEmptyState } from '../panel/PanelEmptyState'
import { Banner, Button, EmptyState, IconButton, Select } from '../ui'

/** Ports of this project's dev servers, the conversation's own first. */
export function projectTargets(targets: PreviewTargetDto[], projectId: string | undefined, conversationId: string | undefined): PreviewTargetDto[] {
  return targets
    .filter((target) => target.projectId === (projectId ?? null))
    .sort((a, b) => Number(b.conversationId === conversationId) - Number(a.conversationId === conversationId) || a.port - b.port)
}

/**
 * The project's dev server inside Sillage. On Server it loads through the preview host (its own
 * origin, signed in by the link); on Desktop straight from the loopback port.
 */
export function PreviewPane({ projectId, conversationId }: { projectId?: string; conversationId?: string }) {
  const t = useTranslate()
  const { data } = usePreviews()
  const { data: me } = useCurrentUser()
  const open = useOpenPreview()
  const openTab = useOpenPreview()
  const targets = projectTargets(data?.targets ?? [], projectId, conversationId)
  const [port, setPort] = useState<number | null>(null)
  const [manual, setManual] = useState('')
  const [reloads, setReloads] = useState(0)
  const [copied, setCopied] = useState(false)

  const chosen = port ?? targets[0]?.port ?? null

  // Sign in to the chosen port; reloading afterwards reuses the preview's own cookie. The frame
  // reads the mutation's state rather than a per-call callback, which a remount would drop.
  const ready = data !== undefined && data.mode !== 'unconfigured'
  useEffect(() => {
    if (chosen === null || !ready) return
    setReloads(0)
    open.mutate(chosen)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosen, ready])
  const opened = open.data && open.variables === chosen ? open.data : null
  const frame = opened ? { url: reloads ? opened.address : opened.url, address: opened.address, key: `${chosen}-${reloads}` } : null

  if (data?.mode === 'unconfigured') {
    return (
      <PanelEmptyState>
        <EmptyState icon={<MonitorPlay size={22} />} title={t('preview.unconfigured.title')} description={t(me?.isAdmin ? 'preview.unconfigured.admin' : 'preview.unconfigured.member')} />
        {me?.isAdmin ? <Link to="/settings/apercus" className="text-sm text-accent hover:underline">{t('preview.unconfigured.link')}</Link> : null}
      </PanelEmptyState>
    )
  }

  const direct = data?.mode === 'direct'
  if (chosen === null) {
    return (
      <PanelEmptyState>
        <EmptyState icon={<MonitorPlay size={22} />} title={t('preview.empty.title')} description={t('preview.empty.description')} />
        {direct ? <ManualPort value={manual} onChange={setManual} onOpen={(value) => setPort(value)} /> : null}
      </PanelEmptyState>
    )
  }

  const reopen = () => {
    setReloads(0)
    open.mutate(chosen)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-line px-2 py-1.5">
        <div className="flex items-center gap-1">
          {targets.length > 0 ? (
            <Select<string>
              className="min-w-0 flex-1"
              placeholder={t('preview.port')}
              value={String(chosen)}
              onChange={(value) => setPort(Number(value))}
              options={[...targets.map((target) => ({ value: String(target.port), label: `:${target.port} · ${target.label}`, hint: target.conversationTitle ?? target.command ?? undefined })),
                ...(targets.some((target) => target.port === chosen) ? [] : [{ value: String(chosen), label: `:${chosen}` }])]}
            />
          ) : <span className="flex-1 px-1 font-mono text-xs text-ink-soft">:{chosen}</span>}
          <IconButton label={t('preview.reload')} size="sm" onClick={() => setReloads((count) => count + 1)}><RotateCw size={14} /></IconButton>
          <IconButton label={t('preview.openTab')} size="sm" disabled={openTab.isPending}
            onClick={() => {
              // Opened before the request resolves, or popup blockers would refuse it.
              const tab = window.open('about:blank', '_blank')
              openTab.mutateAsync(chosen).then((result) => { if (tab) tab.location.href = result.url }, () => tab?.close())
            }}>
            <ExternalLink size={15} />
          </IconButton>
          <IconButton label={copied ? t('preview.copied') : t('preview.copy')} size="sm" disabled={!frame}
            onClick={() => { if (frame) void navigator.clipboard.writeText(frame.address).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }) }}>
            <Copy size={14} />
          </IconButton>
        </div>
        {frame ? <p className="truncate px-1 font-mono text-[11px] text-ink-faint" title={frame.address}>{frame.address}</p> : null}
      </div>
      {open.error ? (
        <div className="p-3"><Banner tone="critical">{open.error.message}</Banner><Button variant="ghost" onClick={reopen}>{t('preview.retry')}</Button></div>
      ) : null}
      <div className="relative flex min-h-0 flex-1 bg-sunken">
        {frame ? (
          <iframe
            key={frame.key}
            data-preview-frame
            title={t('preview.frame', { port: chosen })}
            src={frame.url}
            className="h-full w-full border-0 bg-white"
            // The app is the user's own code on its own origin: same-origin keeps its storage and
            // cookies working there, without reaching Sillage's.
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
          />
        ) : <p className="m-auto text-xs text-ink-faint">{t('preview.loading')}</p>}
      </div>
    </div>
  )
}

/** Desktop has no port discovery off Linux: name the port yourself. */
function ManualPort({ value, onChange, onOpen }: { value: string; onChange: (value: string) => void; onOpen: (port: number) => void }) {
  const t = useTranslate()
  const port = Number(value)
  const valid = Number.isInteger(port) && port >= 1 && port <= 65535
  return (
    <form className="flex items-center gap-2" onSubmit={(event) => { event.preventDefault(); if (valid) onOpen(port) }}>
      <input
        aria-label={t('preview.manual')}
        placeholder="5173"
        inputMode="numeric"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-9 w-24 rounded-md border border-line bg-sunken px-2 font-mono text-sm focus:border-accent focus:outline-none"
      />
      <Button type="submit" disabled={!valid}>{t('preview.manual.open')}</Button>
    </form>
  )
}
