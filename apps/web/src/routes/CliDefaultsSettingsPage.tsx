import { ChevronDown, ShieldAlert, SlidersHorizontal } from 'lucide-react'
import { useRef, useState } from 'react'
import { agentKindSchema, defaultConfigFor, type AgentConfig, type AgentKind } from '@sillage/protocol'
import { AGENT_LABELS, AGENT_META, AgentIcon } from '../components/AgentIcon'
import { useAgentSettings } from '../components/chat/agent-settings'
import { SettingsSurface, type SettingGroup } from '../components/chat/ComposerSettings'
import { RefreshButton, SettingOptions, SettingsHeading } from '../components/chat/SettingsPanel'
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
  if (group.key === 'model' && group.options.length > SEARCHABLE_MODELS) return <ModelField group={group} />
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

/** Beyond this many models a dropdown stops being usable: the composer's searchable list takes over. */
const SEARCHABLE_MODELS = 8

/**
 * The model, chosen in the composer's own panel: search, provider sections and recent models.
 * A plain dropdown cannot hold opencode's hundred models across providers.
 */
function ModelField({ group }: { group: SettingGroup }) {
  // The panel returns focus to a composer when there is one; this page has none.
  const noComposer = useRef<HTMLTextAreaElement>(null)
  const selected = group.options.find((option) => option.value === group.value && !option.shortcut)
  const trigger = (
    <button type="button" aria-label={`${group.label} · ${selected?.label ?? group.value}`}
      className="group tap-target flex w-full min-w-0 items-center gap-2 rounded-md border border-line bg-sunken px-3 text-left text-sm text-ink transition-colors hover:border-line-strong data-[state=open]:border-accent">
      <span className="min-w-0 flex-1 truncate">
        {selected?.label ?? group.value}
        {selected?.group ? <span className="text-ink-faint"> · {selected.group}</span> : null}
      </span>
      <ChevronDown size={16} className="shrink-0 text-ink-faint transition-transform group-data-[state=open]:rotate-180" />
    </button>
  )
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-sm font-medium text-ink-soft">{group.label}</span>
      <SettingsSurface label={group.label} trigger={trigger} inputRef={noComposer} disabled={false} quick side="bottom">
        {(close) => (
          <>
            <SettingsHeading title={group.label} onClose={() => close()}
              action={group.refresh ? <RefreshButton group={group} refresh={group.refresh} /> : null} />
            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
              <SettingOptions group={group} dense onPick={(value) => { group.onChange(value); close() }} />
            </div>
          </>
        )}
      </SettingsSurface>
    </div>
  )
}

