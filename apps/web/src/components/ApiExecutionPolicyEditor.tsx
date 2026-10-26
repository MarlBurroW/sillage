import { useState } from 'react'
import type { ApiAgentPermission, ApiExecutionPolicy, AgentKind } from '@sillage/protocol'
import { AGENT_LABELS, AgentIcon } from './AgentIcon'
import { Field, Select, cx } from './ui'
import { effortLabel, useAgentModels } from '../lib/agents'
import { useTranslate } from '../lib/i18n'

export const unrestrictedAgent = (agent: AgentKind): ApiAgentPermission => ({ agent, models: null, efforts: null, maxBudgetUsd: null })

export function ApiExecutionPolicyEditor({ value, onChange }: { value: ApiExecutionPolicy; onChange: (value: ApiExecutionPolicy) => void }) {
  const t = useTranslate()
  return <fieldset className="min-w-0 space-y-3">
    <legend className="text-sm font-semibold text-ink">{t('apiTokens.policy.title')}</legend>
    <p className="max-w-prose text-sm text-ink-soft">{t('apiTokens.policy.hint')}</p>
    <div className="divide-y divide-line rounded-lg border border-line">
      {(Object.keys(AGENT_LABELS) as AgentKind[]).map((agent) => {
        const rule = value.agents.find((entry) => entry.agent === agent)
        return <div key={agent} className={cx('p-4', rule && 'bg-surface')}>
          <label className="flex cursor-pointer items-center gap-3 text-sm font-medium">
            <input type="checkbox" className="size-4 accent-accent" checked={!!rule} onChange={() => onChange({ agents: rule ? value.agents.filter((entry) => entry.agent !== agent) : [...value.agents, unrestrictedAgent(agent)] })} />
            <AgentIcon agent={agent} size={17} />{AGENT_LABELS[agent]}
            <span className="ml-auto text-xs font-normal text-ink-faint">{rule ? t('apiTokens.policy.allowed') : t('apiTokens.policy.denied')}</span>
          </label>
          {rule ? <RuleFields rule={rule} onChange={(next) => onChange({ agents: value.agents.map((entry) => entry.agent === agent ? next : entry) })} /> : null}
        </div>
      })}
    </div>
    {value.agents.length === 0 ? <p role="alert" className="text-sm text-critical">{t('apiTokens.policy.selectCli')}</p> : null}
  </fieldset>
}

function RuleFields({ rule, onChange }: { rule: ApiAgentPermission; onChange: (value: ApiAgentPermission) => void }) {
  const t = useTranslate()
  const { data: catalog, isPending, error } = useAgentModels(rule.agent)
  const models = catalog?.models ?? []
  const efforts = [...new Map(models.filter((model) => !rule.models || rule.models.includes(model.value))
    .flatMap((model) => model.efforts).map((effort) => [effort.value, effort])).values()]
  return <div className="mt-4 grid gap-4 xl:grid-cols-2">
    <AllowedValues label={t('apiTokens.policy.models')} allLabel={t('apiTokens.policy.allModels')} value={rule.models}
      options={models.map((model) => ({ value: model.value, label: model.displayName }))} onChange={(models) => onChange({ ...rule, models })} />
    <AllowedValues label={t('apiTokens.policy.efforts')} allLabel={t('apiTokens.policy.allEfforts')} value={rule.efforts}
      options={efforts.map((effort) => ({ value: effort.value, label: effortLabel(t, effort) }))} onChange={(efforts) => onChange({ ...rule, efforts })} />
    {isPending || error ? <p className="text-xs text-ink-faint xl:col-span-2">{t(isPending ? 'apiTokens.policy.loading' : 'apiTokens.policy.unavailable')}</p> : null}
    {rule.agent === 'claude' ? <Field label={t('apiTokens.policy.budget')} hint={t('apiTokens.policy.budgetHint')} type="number" min="0.01" step="0.01" value={rule.maxBudgetUsd ?? ''} placeholder={t('apiTokens.policy.noBudget')}
      onChange={(event) => onChange({ ...rule, maxBudgetUsd: event.target.value ? Number(event.target.value) : null })} /> : null}
  </div>
}

function AllowedValues({ label, allLabel, value, options, onChange }: {
  label: string; allLabel: string; value: string[] | null; options: { value: string; label: string }[]; onChange: (value: string[] | null) => void
}) {
  const t = useTranslate()
  const [custom, setCustom] = useState('')
  const extra = value?.filter((entry) => !options.some((option) => option.value === entry)) ?? []
  return <div className="min-w-0 space-y-2">
    <Select label={label} value={value === null ? 'all' : 'selected'} onChange={(mode) => onChange(mode === 'all' ? null : [])}
      options={[{ value: 'all', label: allLabel }, { value: 'selected', label: t('apiTokens.policy.selected') }]} />
    {value !== null ? <>
      <div className="flex flex-wrap gap-2">
        {[...options, ...extra.map((entry) => ({ value: entry, label: entry }))].map((option) => <label key={option.value} className={cx('flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-2 text-xs', value.includes(option.value) ? 'border-accent bg-accent-wash text-ink' : 'border-line text-ink-soft')}>
          <input type="checkbox" checked={value.includes(option.value)} className="size-3.5 accent-accent" onChange={() => onChange(value.includes(option.value) ? value.filter((entry) => entry !== option.value) : [...value, option.value])} />{option.label}
        </label>)}
      </div>
      <details><summary className="cursor-pointer text-xs text-ink-faint">{t('apiTokens.policy.ids', { label })}</summary>
        <Field label={t('apiTokens.policy.ids', { label })} hint={t('apiTokens.policy.idsHint')} value={custom}
          onChange={(event) => setCustom(event.target.value)} onBlur={() => {
            if (!custom.trim()) return
            onChange([...new Set([...value, ...custom.split(',').map((entry) => entry.trim()).filter(Boolean)])])
            setCustom('')
          }} />
      </details>
      {value.length === 0 ? <p role="alert" className="text-xs text-critical">{t('apiTokens.policy.selectValue')}</p> : null}
    </> : null}
  </div>
}
