import * as Dialog from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { useState } from 'react'
import { defaultConfigFor, shortModelName, type AgentAvailabilityDto, type AgentConfig, type AgentKind } from '@sillage/protocol'
import { useAgentModels } from '../../lib/agents'
import { formatListPrice, newRowKey, withCatalogModel, type LineupRow } from '../../lib/benchmark-lineup'
import { locale, useTranslate } from '../../lib/i18n'
import { AGENT_LABELS, AgentIcon } from '../AgentIcon'
import { Banner, Button, IconButton, Segmented, cx } from '../ui'

/**
 * Several models of one CLI added at once, from its catalog: the quickest way to a lineup of ten.
 * Each becomes a row copying the last row of that CLI (permissions, account, effort when the model
 * offers it), or the account defaults when the lineup has none yet.
 */
export function AddModelsDialog({ rows, availability, remaining, defaults, onAdd, onClose }: {
  rows: LineupRow[]
  availability: AgentAvailabilityDto[] | undefined
  /** Rows the lineup can still take. */
  remaining: number
  defaults: (agent: AgentKind) => AgentConfig | undefined
  onAdd: (rows: LineupRow[]) => void
  onClose: () => void
}) {
  const t = useTranslate()
  const installed = (availability ?? []).filter((entry) => entry.installed && entry.enabled).map((entry) => entry.agent)
  // A CLI that is not installed has no catalog to read: start on one that has.
  const [agent, setAgent] = useState<AgentKind>(() => {
    const last = rows[rows.length - 1]?.agent
    return last && installed.includes(last) ? last : (installed[0] ?? last ?? 'claude')
  })
  const none = installed.length === 0
  const [picked, setPicked] = useState<string[]>([])
  const base = [...rows].reverse().find((row) => row.agent === agent && row.config)?.config ?? defaults(agent) ?? defaultConfigFor(agent)
  const catalog = useAgentModels(agent, installed.includes(agent), 'account' in base ? base.account : null)
  // The default entry repeats an alias under another name: offering both would add the same model twice.
  const models = (catalog.data?.models ?? []).filter((model) => !model.isDefault)
  const present = new Set(rows.filter((row) => row.agent === agent).map((row) => row.config?.model))
  const full = picked.length >= remaining

  const change = (next: AgentKind) => {
    setAgent(next)
    setPicked([])
  }
  const toggle = (value: string) =>
    setPicked((current) => (current.includes(value) ? current.filter((entry) => entry !== value) : full ? current : [...current, value]))
  const add = () => {
    const chosen = models.filter((model) => picked.includes(model.value))
    onAdd(chosen.map((model) => {
      const config = withCatalogModel(base, model)
      return { key: newRowKey(), agent: config.agent, config, label: null }
    }))
  }

  return (
    <Dialog.Root open onOpenChange={(open) => { if (!open) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
        <Dialog.Content
          aria-describedby="benchmark-add-models-description"
          className="surface fixed inset-0 top-[var(--sg-window-bar,0px)] z-50 flex min-h-0 flex-col overflow-clip border-line shadow-pop sm:inset-x-[max(1.25rem,calc((100vw-40rem)/2))] sm:inset-y-[8dvh] sm:rounded-lg sm:border"
          data-add-models
        >
          <div className="flex shrink-0 items-start justify-between gap-3 border-b border-line px-4 py-3 sm:px-5">
            <div className="min-w-0">
              <Dialog.Title className="text-base font-semibold">{t('benchmark.lineup.addModels.title')}</Dialog.Title>
              <Dialog.Description id="benchmark-add-models-description" className="mt-1 text-sm text-ink-faint">{t('benchmark.lineup.addModels.description')}</Dialog.Description>
            </div>
            <Dialog.Close asChild><IconButton label={t('common.close')}><X size={19} /></IconButton></Dialog.Close>
          </div>
          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-3 sm:px-5">
            {installed.length > 1 ? (
              <Segmented
                label={t('draft.cli.legend')}
                value={agent}
                onChange={change}
                options={installed.map((value) => ({ value, label: AGENT_LABELS[value], icon: <AgentIcon agent={value} size={15} />, text: AGENT_LABELS[value] }))}
              />
            ) : null}
            {none ? <Banner tone="caution">{t('benchmark.lineup.addModels.noCli')}</Banner>
              : catalog.isPending ? <p role="status" className="py-8 text-center text-sm text-ink-faint">{t('schedule.loading')}</p>
              : catalog.isError ? <Banner tone="caution">{t('composer.catalog.unavailable')}</Banner>
                : (
                  <ul className="flex flex-col divide-y divide-line rounded-lg border border-line" data-add-models-list>
                    {models.map((model) => {
                      const checked = picked.includes(model.value)
                      const disabled = !checked && full
                      return (
                        <li key={model.value}>
                          <label className={cx('flex cursor-pointer items-center gap-3 px-3 py-2', disabled && 'cursor-not-allowed opacity-45')}>
                            <input type="checkbox" checked={checked} disabled={disabled} onChange={() => toggle(model.value)} className="size-4 shrink-0 accent-[var(--sg-accent)]" />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm text-ink">{model.publicName ? shortModelName(model.publicName) : model.displayName}</span>
                              <span className="block truncate font-mono text-[0.6875rem] text-ink-faint">{model.hint ?? model.value}</span>
                            </span>
                            {present.has(model.value) ? <span className="shrink-0 rounded-sm bg-surface-high px-1.5 text-[0.6875rem] leading-5 text-ink-soft">{t('benchmark.lineup.addModels.present')}</span> : null}
                            <span className="shrink-0 text-xs text-ink-faint tabular-nums">{model.listPrice ? formatListPrice(model.listPrice, locale()) : t('benchmark.lineup.price.unknown')}</span>
                          </label>
                        </li>
                      )
                    })}
                  </ul>
                )}
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-line px-4 py-3 sm:px-5">
            <p className="mr-auto text-xs text-ink-faint">{full ? t('benchmark.lineup.addModels.full', { count: remaining }) : t('benchmark.lineup.addModels.picked', { count: picked.length })}</p>
            <Dialog.Close asChild><Button variant="ghost">{t('dialog.cancel')}</Button></Dialog.Close>
            <Button disabled={picked.length === 0} onClick={add}>{t('benchmark.lineup.addModels.confirm', { count: picked.length })}</Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
