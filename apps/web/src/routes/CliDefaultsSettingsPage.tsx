import { ShieldAlert, SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'
import { agentKindSchema, defaultConfigFor, type AgentConfig, type AgentKind } from '@sillage/protocol'
import { AGENT_LABELS, AGENT_META, AgentIcon } from '../components/AgentIcon'
import { useAgentSettings } from '../components/chat/agent-settings'
import type { SettingGroup } from '../components/chat/ComposerSettings'
import { Banner, Card, CardBody, CardHeader, ChoiceList, Select } from '../components/ui'
import { useTranslate } from '../lib/i18n'
import { useUpdateAgentDefault, useUserSettings } from '../lib/user-settings'
import { SectionHeader } from './SettingsPage'

/**
 * Defaults for future conversations.
 *
 * Account-level rather than instance-level: permission mode concerns the reader, and two people
 * in one project need not share safeguards. Existing conversations retain their own
 * configurations: changing defaults must not alter an open thread under the user's hands.
 *
 * Same categories and source as the composer panel: these settings are exactly what users find
 * there, expanded rather than hidden behind a single-line trigger.
 */
export function CliDefaultsSettingsPage() {
  const t = useTranslate()
  const { data: settings } = useUserSettings()
  const update = useUpdateAgentDefault()

  const [agent, setAgent] = useState<AgentKind>('claude')
  /**
   * Pending choice until the route confirms. Otherwise every selected option would revert
   * during the round trip. Discarded when switching CLIs: Claude configurations are meaningless
   * for Codex.
   */
  const [edited, setEdited] = useState<AgentConfig | null>(null)
  const stored = settings?.agentDefaults[agent]
  const config = edited?.agent === agent ? edited : (stored ?? defaultConfigFor(agent))

  const save = (next: AgentConfig) => {
    setEdited(next)
    update.mutate(next)
  }

  const { groups, mcp, catalogError } = useAgentSettings({ config, onConfigChange: save })

  const agents = agentKindSchema.options.map((value) => ({
    value,
    label: AGENT_LABELS[value],
    hint: AGENT_META[value].vendor,
    icon: <AgentIcon agent={value} size={16} />,
  }))

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title={t('cliDefaults.section.title')}
        description={t('cliDefaults.section.description')}
      />

      <Card>
        <CardHeader
          title={t('cliDefaults.agent.title')}
          description={t('cliDefaults.agent.description')}
          icon={<SlidersHorizontal size={16} />}
        />
        <CardBody>
          <ChoiceList
            label={t('draft.cli.legend')}
            value={agent}
            options={agents}
            onChange={setAgent}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={AGENT_LABELS[agent]} icon={<AgentIcon agent={agent} size={16} />} />
        <CardBody className="flex flex-col gap-4">
          {catalogError ? <Banner tone="caution">{t('composer.catalog.unavailable')}</Banner> : null}
          {update.isError ? <Banner>{t('cliDefaults.save.error')}</Banner> : null}

          {/*
           * Wait until account defaults are known: earlier display would offer values that are
           * not the user's, and clicking would save them permanently.
           */}
          {settings ? (
            <>
              {groups.map((group) => (
                <GroupField key={group.key} group={group} />
              ))}

              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-ink-soft">
                  {t('cliDefaults.mcp.label')}
                </span>
                {/*
                 * The control already has an icon and count: another surrounding marker would
                 * create two handles for one setting.
                 */}
                <div className="flex">{mcp}</div>
                <p className="text-xs text-ink-faint">{t('cliDefaults.mcp.hint')}</p>
              </div>
            </>
          ) : null}
        </CardBody>
      </Card>
    </div>
  )
}

/**
 * One category as a dropdown: the model list is too long to expand, and consistent controls are
 * better than unique shapes for every setting. Warnings the trigger cannot carry appear below
 * the field: this is the only place safeguards are chosen without seeing the work they govern.
 */
function GroupField({ group }: { group: SettingGroup }) {
  const selected = group.options.find((option) => option.value === group.value)

  return (
    <div className="flex flex-col gap-1.5">
      <Select
        label={group.label}
        value={group.value}
        options={group.options}
        onChange={group.onChange}
      />
      {selected?.tone === 'caution' ? (
        <p className="flex items-start gap-1.5 text-xs text-caution">
          <ShieldAlert size={13} className="mt-0.5 shrink-0" />
          <span>{selected.hint}</span>
        </p>
      ) : null}
    </div>
  )
}
