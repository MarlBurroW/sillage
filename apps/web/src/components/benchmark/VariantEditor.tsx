import { agentKindSchema, defaultConfigFor, type AgentConfig, type AgentKind } from '@sillage/protocol'
import { useTranslate } from '../../lib/i18n'
import { AGENT_LABELS, AgentIcon } from '../AgentIcon'
import type { SettingGroup } from '../chat/ComposerSettings'
import { GroupField } from '../schedule/GroupField'
import { Banner, Select } from '../ui'

/**
 * The settings a benchmark varies, plus permissions: runs are unattended, and a mode that asks
 * blocks the run until someone answers in its conversation. MCP and skills stay at their defaults
 * so variants differ only by what is measured.
 */
export const VARIED_KEYS = new Set(['model', 'effort', 'account', 'permission', 'approval', 'sandbox'])

/**
 * The fields of one variant, opened from its lineup row: CLI, then the model, effort and account
 * choices the composer offers for that CLI. The row calls `useAgentSettings` once and passes its
 * groups here, so the collapsed summary and these fields read the same catalog.
 */
export function VariantFields({
  config,
  groups,
  catalogError,
  onChange,
  defaults,
}: {
  config: AgentConfig
  groups: SettingGroup[]
  catalogError: Error | null
  onChange: (config: AgentConfig) => void
  /** Account defaults per CLI, applied when the CLI changes. */
  defaults: (agent: AgentKind) => AgentConfig | undefined
}) {
  const t = useTranslate()
  const varied = groups.filter((group) => VARIED_KEYS.has(group.key))
  return (
    <div className="@container/variant flex flex-col gap-3">
      {catalogError ? <Banner tone="caution">{t('composer.catalog.unavailable')}</Banner> : null}
      <div className="grid gap-3 @min-[28rem]/variant:grid-cols-2 @min-[44rem]/variant:grid-cols-3">
        <Select
          label={t('draft.cli.legend')}
          value={config.agent}
          onChange={(agent) => onChange(defaults(agent) ?? defaultConfigFor(agent))}
          options={agentKindSchema.options.map((value) => ({
            value,
            label: AGENT_LABELS[value],
            icon: <AgentIcon agent={value} size={16} />,
          }))}
        />
        {varied.map((group) => (
          <GroupField key={group.key} group={group} />
        ))}
      </div>
    </div>
  )
}
