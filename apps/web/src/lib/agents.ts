import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  PREFERRED_CLI_RELEASES,
  isCompatibleVersion,
  type AgentAvailabilityDto,
  type AgentAvailabilityListDto,
  type AgentEffortDto,
  type AgentKind,
  type AgentModelDto,
  type AgentModelsDto,
} from '@sillage/protocol'
import { useMemo } from 'react'
import { translate, useTranslate, type MessageKey } from './i18n'
import { api } from './api'
import { useUpdateHiddenAgents, useUserSettings } from './user-settings'

/**
 * CLI presence and versions on the server machine. Sillage no longer bundles binaries: omit agents
 * whose CLI is missing so users do not discover the absence through a failed first message.
 */
export function useAgentAvailability() {
  return useQuery({
    queryKey: ['agents', 'availability'],
    queryFn: () => api.get<AgentAvailabilityListDto>('/api/agents'),
    // The probe launches a process for each present CLI. CLIs do not install while a form is being
    // filled, and the server has its own cache.
    staleTime: 60 * 1000,
    // Except during installation: it finishes server-side without pushing an update, the only time
    // this state changes on its own.
    refetchInterval: (query) =>
      query.state.data?.agents.some((a) => a.install.status === 'running') ? 2000 : false,
  })
}

/**
 * Install a CLI's tested version. The server responds before completion; the probe reports
 * completion, hence immediate invalidation instead of waiting.
 */
export function useInstallAgent() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (agent: AgentKind) => api.post(`/api/agents/${agent}/install`, {}),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['agents', 'availability'] }),
  })
}

/**
 * CLI installation model for screens: availability, progress, display text, and action. Shared by
 * the draft page and onboarding; each places its button and text independently. `label` is the CLI
 * display name already known by the screen.
 */
export function useAgentInstall(entry: AgentAvailabilityDto | undefined, label: string) {
  const t = useTranslate()
  const install = useInstallAgent()
  const state = entry?.install
  const running = state?.status === 'running'
  const failed = state?.status === 'failed'
  return {
    /** True when installation can be offered: the CLI is missing and has not been disabled. */
    offered: entry !== undefined && !entry.installed && entry.reason !== 'disabled',
    running,
    failed,
    /** Current situation: installation progress, failure reason, or absence. */
    status: running
      ? t('agent.install.running', { label, version: state.version })
      : failed
        ? state.error
        : t('agent.install.missing', { label }),
    /** Button label: install the target version or retry. */
    action: failed ? t('agent.install.retry') : t('agent.install.action', { version: entry?.preferredVersion ?? '' }),
    busy: running || install.isPending,
    /**
     * Installation progress for `AgentInstallProgress`, null otherwise. Set an empty starting state
     * immediately on click, before the server reply, so the button responds during the round trip.
     */
    progress: running
      ? { startedAt: state.startedAt, fetched: state.fetched, current: state.current }
      : install.isPending
        ? { startedAt: Date.now(), fetched: 0, current: null }
        : null,
    start: () => {
      if (entry) install.mutate(entry.agent)
    },
  }
}

/**
 * CLIs hidden by this account while missing, with actions to hide one or restore all. Installed
 * CLIs are never hidden: the preference only hides installation prompts; see `hiddenAgent`.
 */
export function useHiddenAgents() {
  const { data: settings } = useUserSettings()
  const update = useUpdateHiddenAgents()
  const hidden = useMemo(() => settings?.hiddenAgents ?? [], [settings?.hiddenAgents])
  return {
    hidden,
    hide: (agent: AgentKind) => update.mutate([...hidden, agent]),
    reveal: () => update.mutate([]),
  }
}

/** A CLI to omit: hidden by the account and still missing. */
export function hiddenAgent(entry: AgentAvailabilityDto | undefined, hidden: AgentKind[]): boolean {
  return entry !== undefined && !entry.installed && hidden.includes(entry.agent)
}

/** Displayable reason why an agent cannot be selected, or null when selectable. */
export function unavailableReason(entry: AgentAvailabilityDto | undefined): string | null {
  if (!entry || entry.installed) return null
  switch (entry.reason) {
    case 'disabled':
      return translate('agent.unavailable.disabled')
    case 'not_executable':
      return translate('agent.unavailable.notExecutable', { binary: entry.binary })
    default:
      return translate('agent.unavailable.notOnPath', { binary: entry.binary })
  }
}

/**
 * Difference between installed and Sillage-targeted versions, displayed as a warning. Null when
 * compatible or incomparable. Does not block selection or disable cards: report the mismatch and
 * keep offering target-version installation alongside.
 */
export function versionMismatch(entry: AgentAvailabilityDto | undefined): string | null {
  if (!entry?.installed || !entry.version) return null
  const preferred = PREFERRED_CLI_RELEASES[entry.agent].version
  // `null` means unreadable, with nothing to report: only a confirmed false warrants a warning.
  if (isCompatibleVersion(entry.version, preferred) !== false) return null
  return translate('agent.version.mismatch', { installed: entry.version, preferred })
}

/**
 * Models declared by the installed CLI in the protocol's shared format. Nothing is hardcoded:
 * updating the CLI exposes new models without changing Sillage.
 */
export function useAgentModels(agent: AgentKind, enabled = true, account: string | null = null) {
  return useQuery({
    queryKey: ['agents', agent, 'models', account],
    queryFn: () => api.get<AgentModelsDto>(`/api/agents/${agent}/models${account ? `?account=${encodeURIComponent(account)}` : ''}`),
    // The probe starts a CLI: do not rerun it on every composer mount or for conversations using another agent.
    staleTime: 60 * 60 * 1000,
    retry: false,
    enabled,
  })
}

/**
 * Catalog entry matching a saved model. Try the exact value first, then models still accepted under
 * former names: `opus[1m]`, removed from the Claude Code 2.1.282 selector once Opus gained a
 * default million-token context, or `claude-fable-5-1`, listed as `fable` in 2.1.291. Without this
 * fallback, older conversations lost effort, speed, and Ultracode settings. Exclude the default
 * entry from the last-resort match: it points to the same model as an alias but follows future CLI
 * default changes.
 */
export function catalogModel(models: AgentModelDto[] | undefined, value: string): AgentModelDto | undefined {
  if (!models) return undefined
  const exact = models.find((model) => model.value === value)
  if (exact) return exact
  const bare = value.replace(/\[1m\]$/i, '')
  return (
    models.find((model) => model.value === bare) ??
    models.find((model) => !model.isDefault && model.hint === bare)
  )
}

/**
 * Effort levels of the selected model. Some models, such as Haiku, have none: offering a setting
 * with no effect would mislead users.
 */
export function effortsFor(models: AgentModelDto[] | undefined, value: string): AgentEffortDto[] {
  return catalogModel(models, value)?.efforts ?? []
}

/** Levels shared by the three CLIs; opencode-specific variants retain their names. */
const EFFORT_KEYS: Record<string, MessageKey> = {
  none: 'effort.level.none',
  minimal: 'effort.level.minimal',
  low: 'effort.level.low',
  medium: 'effort.level.medium',
  high: 'effort.level.high',
  xhigh: 'effort.level.xhigh',
  max: 'effort.level.max',
}

/**
 * Effort-level label in the UI language. The server does not know that language: it sends the value
 * and an English label (Claude) or raw value (Codex, opencode), used only as fallback for unknown
 * levels.
 */
export function effortLabel(t: (key: MessageKey) => string, effort: AgentEffortDto): string {
  const key = EFFORT_KEYS[effort.value]
  return key ? t(key) : effort.label
}

/**
 * Whether the selected model supports fast mode. False for unknown models: enabling it would
 * silently switch the CLI to Opus, which this setting must prevent.
 */
export function supportsFastMode(models: AgentModelDto[] | undefined, value: string): boolean {
  return catalogModel(models, value)?.supportsFastMode === true
}
