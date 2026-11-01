import { Trash2 } from 'lucide-react'
import { agentKindSchema, defaultConfigFor, type AgentConfig, type AgentKind } from '@sillage/protocol'
import { useTranslate } from '../../lib/i18n'
import { AGENT_LABELS, AgentIcon } from '../AgentIcon'
import { useAgentSettings } from '../chat/agent-settings'
import { GroupField } from '../schedule/GroupField'
import { Banner, IconButton, Select } from '../ui'

/** The settings a benchmark varies. Permissions, MCP and skills stay at their defaults so variants differ only by what is measured. */
const VARIED_KEYS = new Set(['model', 'effort', 'account'])

/**
 * One row of the variant list: CLI, then the model, effort and account choices the composer offers
 * for that CLI. Reuses the composer's settings model so catalogs, aliases and account-scoped lists
 * behave exactly as in a draft.
 */
export function VariantEditor({
  config,
  onChange,
  onRemove,
  removable,
  defaults,
}: {
  config: AgentConfig
  onChange: (config: AgentConfig) => void
  onRemove: () => void
  removable: boolean
  /** Account defaults per CLI, applied when the CLI changes. */
  defaults: (agent: AgentKind) => AgentConfig | undefined
}) {
  const t = useTranslate()
  const { groups, catalogError } = useAgentSettings({ config, onConfigChange: onChange })
  const varied = groups.filter((group) => VARIED_KEYS.has(group.key))

  return (
    <li className="flex flex-col gap-3 rounded-lg border border-line p-3" data-benchmark-variant>
      <div className="flex items-end gap-2">
        <Select
          className="flex-1"
          label={t('draft.cli.legend')}
          value={config.agent}
          onChange={(agent) => onChange(defaults(agent) ?? defaultConfigFor(agent))}
          options={agentKindSchema.options.map((value) => ({
            value,
            label: AGENT_LABELS[value],
            icon: <AgentIcon agent={value} size={16} />,
          }))}
        />
        <IconButton label={t('benchmark.form.removeVariant')} disabled={!removable} onClick={onRemove}>
          <Trash2 size={16} />
        </IconButton>
      </div>
      {catalogError ? <Banner tone="caution">{t('composer.catalog.unavailable')}</Banner> : null}
      <div className="grid gap-3 sm:grid-cols-3">
        {varied.map((group) => (
          <GroupField key={group.key} group={group} />
        ))}
      </div>
    </li>
  )
}
