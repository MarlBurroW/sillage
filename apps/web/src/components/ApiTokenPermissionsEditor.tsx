import { useState } from 'react'
import { DEFAULT_CONFIGS, EFFORT_FIELD, agentConfigSchema, type AgentConfig, type ApiExecutionPolicy, type ApiTokenDto, type AgentKind } from '@sillage/protocol'
import { ApiExecutionPolicyEditor, unrestrictedAgent } from './ApiExecutionPolicyEditor'
import { AGENT_LABELS } from './AgentIcon'
import { Banner, Button, Select } from './ui'
import { useAgentModels, effortLabel, effortsFor, modelsAccount } from '../lib/agents'
import { useUpdateApiTokenPermissions } from '../lib/api-tokens'
import { useTranslate } from '../lib/i18n'

/** Editing limits keeps the secret and preserves unrelated CLI safeguards. */
export function ApiTokenPermissionsEditor({ token, onDone }: { token: ApiTokenDto; onDone: () => void }) {
  const t = useTranslate()
  const update = useUpdateApiTokenPermissions()
  const [policy, setPolicy] = useState<ApiExecutionPolicy>(token.executionPolicy ?? { agents: (Object.keys(AGENT_LABELS) as AgentKind[]).map(unrestrictedAgent) })
  const [config, setConfig] = useState(() => agentConfigSchema.parse(token.config))
  const { data: catalog } = useAgentModels(config.agent, true, modelsAccount(config))
  const rule = policy.agents.find((entry) => entry.agent === config.agent)
  const models = catalog?.models ?? []
  const modelValues = rule?.models ?? models.map((entry) => entry.value)
  const efforts = effortsFor(models, config.model)
  const effortValues = rule?.efforts ?? efforts.map((entry) => entry.value)
  const effortField = EFFORT_FIELD[config.agent]
  const patch = (value: Record<string, unknown>) => setConfig({ ...config, ...value } as AgentConfig)
  const fit = (base: AgentConfig, next: ApiExecutionPolicy) => {
    const allowed = next.agents.find((entry) => entry.agent === base.agent) ?? next.agents[0]
    if (!allowed) return base
    const result = base.agent === allowed.agent ? { ...base } : { ...DEFAULT_CONFIGS[allowed.agent] }
    if (allowed.models && !allowed.models.includes(result.model)) result.model = allowed.models[0] ?? ''
    const field = EFFORT_FIELD[result.agent]
    const record = result as unknown as Record<string, unknown>
    if (allowed.efforts && !allowed.efforts.includes(String(record[field]))) record[field] = allowed.efforts[0] ?? ''
    return result
  }
  return <form className="flex basis-full flex-col gap-5 border-t border-line pt-4" onSubmit={(event) => {
    event.preventDefault()
    update.mutate({ id: token.id, executionPolicy: policy, agent: config.agent, config }, { onSuccess: onDone })
  }}>
    <p className="max-w-prose text-sm text-ink-soft">{t('apiTokens.edit.hint')}</p>
    <ApiExecutionPolicyEditor value={policy} onChange={(next) => { setPolicy(next); setConfig(fit(config, next)) }} />
    <fieldset className="min-w-0 space-y-3">
      <legend className="text-sm font-semibold">{t('apiTokens.defaults.title')}</legend>
      <p className="max-w-prose text-sm text-ink-soft">{t('apiTokens.defaults.hint')}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Select label={t('apiTokens.agent.label')} value={config.agent} options={policy.agents.map((entry) => ({ value: entry.agent, label: AGENT_LABELS[entry.agent] }))}
          onChange={(agent) => setConfig(fit(agent === token.agent ? agentConfigSchema.parse(token.config) : DEFAULT_CONFIGS[agent], policy))} />
        <Select label={t('apiTokens.model.label')} value={config.model} onChange={(model) => patch({ model })}
          options={[...(!rule?.models ? [{ value: '', label: t('apiTokens.model.default') }] : []), ...[...new Set([...modelValues, ...(config.model ? [config.model] : [])])].map((value) => ({ value, label: models.find((model) => model.value === value)?.displayName ?? value }))]} />
        <Select label={t('apiTokens.effort.label')} value={String((config as unknown as Record<string, unknown>)[effortField])} onChange={(value) => patch({ [effortField]: value })}
          options={[...(!rule?.efforts && config.agent !== 'claude' ? [{ value: '', label: t('apiTokens.effort.default') }] : []), ...[...new Set([...effortValues, ...((config as unknown as Record<string, unknown>)[effortField] ? [String((config as unknown as Record<string, unknown>)[effortField])] : [])])].map((value) => ({ value, label: effortLabel(t, efforts.find((entry) => entry.value === value) ?? { value, label: value, hint: null }) }))]} />
      </div>
    </fieldset>
    {update.error ? <Banner>{update.error.message}</Banner> : null}
    <div className="flex flex-wrap gap-2">
      <Button type="submit" disabled={update.isPending || !policy.agents.length || policy.agents.some((entry) => entry.models?.length === 0 || entry.efforts?.length === 0)}>{t('apiTokens.edit.save')}</Button>
      <Button variant="ghost" onClick={onDone}>{t('common.cancel')}</Button>
    </div>
  </form>
}
