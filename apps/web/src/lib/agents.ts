import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import {
  PREFERRED_CLI_RELEASES,
  compareCliVersions,
  type CliInstallStateDto,
  isCompatibleVersion,
  type AgentAvailabilityDto,
  type AgentConfig,
  type AgentAvailabilityListDto,
  type AgentEffortDto,
  type AgentKind,
  type AgentModelDto,
  type AgentModelsDto,
} from '@sillage/protocol'
import { useMemo } from 'react'
import { translate, translateError, useTranslate, type MessageKey } from './i18n'
import { api } from './api'
import { useCurrentUser } from './session'
import { useUpdateHiddenAgents, useUserSettings } from './user-settings'

/**
 * CLI presence and versions on the server machine. Sillage no longer bundles binaries: omit agents
 * whose CLI is missing so users do not discover the absence through a failed first message.
 */
const AVAILABILITY_KEY = ['agents', 'availability']

async function readAvailability(client: QueryClient, force = false, signal?: AbortSignal) {
  const previous = client.getQueryData<AgentAvailabilityListDto>(AVAILABILITY_KEY)
  const next = await api.get<AgentAvailabilityListDto>(`/api/agents${force ? '?refresh=1' : ''}`, signal)
  for (const entry of next.agents) {
    const before = previous?.agents.find((item) => item.agent === entry.agent)
    if (before && (before.version !== entry.version || before.path !== entry.path ||
      (entry.install.status === 'idle' && (before.install.status === 'running' || before.install.status === 'queued')))) {
      // Invalidate every account, including inactive queries kept for other conversations.
      void client.invalidateQueries({ queryKey: ['agents', entry.agent] })
      void client.invalidateQueries({ predicate: (query) => query.queryKey[0] === 'project-commands' && query.queryKey[2] === entry.agent })
    }
  }
  return next
}

export function useAgentAvailability(enabled = true) {
  const client = useQueryClient()
  return useQuery({
    queryKey: AVAILABILITY_KEY,
    queryFn: ({ signal }) => readAvailability(client, false, signal),
    staleTime: 60 * 1000,
    enabled,
    refetchInterval: (query) => query.state.data?.agents.some((a) =>
      a.install.status === 'running' || a.install.status === 'queued') ? 2000 : false,
  })
}

export function useRefreshAgentAvailability() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => readAvailability(client, true),
    onSuccess: (data) => client.setQueryData(AVAILABILITY_KEY, data),
  })
}

/** Only older releases need updates. Newer or unknown versions are never labelled out of date. */
export function cliNeedsUpdate(entry: AgentAvailabilityDto): boolean {
  return entry.enabled && entry.installed && entry.version !== null &&
    (compareCliVersions(entry.version, entry.preferredVersion) ?? 0) < 0
}

/** Mounted with navigation so version checks also run when users never open settings. */
export function useCliUpdateNotice(): boolean {
  const { data: user } = useCurrentUser()
  const { data } = useAgentAvailability(user?.isAdmin === true)
  return user?.isAdmin === true && (data?.agents.some(cliNeedsUpdate) ?? false)
}

/** The accepted state enables polling even when installation finishes before the first GET. */
export function useInstallAgent() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (agent: AgentKind) => api.post<CliInstallStateDto>(`/api/agents/${agent}/install`, {}),
    onSuccess: (install, agent) => client.setQueryData<AgentAvailabilityListDto>(AVAILABILITY_KEY, (data) =>
      data && ({ agents: data.agents.map((entry) => entry.agent === agent ? { ...entry, install } : entry) })),
    onSettled: () => client.invalidateQueries({ queryKey: AVAILABILITY_KEY }),
  })
}

export function useCancelAgentInstall() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (agent: AgentKind) => api.delete(`/api/agents/${agent}/install`),
    onSettled: () => client.invalidateQueries({ queryKey: AVAILABILITY_KEY }),
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
  const { data: user } = useCurrentUser()
  const state = entry?.install
  const running = state?.status === 'running'
  const queued = state?.status === 'queued'
  // Another administrator may complete the update after this browser's request failed.
  const requestFailed = install.isError && !running && !queued && entry?.version !== entry?.preferredVersion
  const failed = state?.status === 'failed' || requestFailed
  return {
    /** True when installation can be offered: the CLI is missing and has not been disabled. */
    offered: user?.isAdmin === true && entry !== undefined && !entry.installed && entry.reason !== 'disabled' && entry.installable !== false,
    running,
    queued,
    failed,
    /** Current situation: installation progress, failure reason, or absence. */
    status: running
      ? t('agent.install.running', { label, version: state.version })
      : queued
        ? t(state.reason === 'sessions' ? 'cliUpdates.waitingSessions' : 'cliUpdates.waitingInstall')
        : requestFailed
          ? install.error.message
          : state?.status === 'failed'
            ? translateError(state.code ?? 'cli_install_failed', state.error, state.params)
            : t('agent.install.missing', { label }),
    /** Button label: install the target version or retry. */
    action: failed ? t('agent.install.retry') : t('agent.install.action', { version: entry?.preferredVersion ?? '' }),
    busy: running || queued || install.isPending,
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

/** Account whose catalog a configuration needs: every CLI with additional accounts lists the models of the signed-in plan. */
export function modelsAccount(config: AgentConfig): string | null {
  return 'account' in config ? config.account : null
}

const modelsKey = (agent: AgentKind, account: string | null) => ['agents', agent, 'models', account]

const modelsPath = (agent: AgentKind, account: string | null, refresh: boolean) => {
  const params = new URLSearchParams()
  if (account) params.set('account', account)
  if (refresh) params.set('refresh', '1')
  const query = params.toString()
  return `/api/agents/${agent}/models${query ? `?${query}` : ''}`
}

/**
 * Models declared by the installed CLI in the protocol's shared format. Nothing is hardcoded:
 * updating the CLI exposes new models without changing Sillage.
 */
export function useAgentModels(agent: AgentKind, enabled = true, account: string | null = null) {
  return useQuery({
    queryKey: modelsKey(agent, account),
    queryFn: () => api.get<AgentModelsDto>(modelsPath(agent, account, false)),
    // The probe starts a CLI: do not rerun it on every composer mount or for conversations using another agent.
    staleTime: 60 * 60 * 1000,
    retry: false,
    enabled,
  })
}

/** Explicit refetch bypassing the server cache too: a login or plan change does not wait an hour. */
export function useRefreshAgentModels(agent: AgentKind, account: string | null = null) {
  const queryClient = useQueryClient()
  return async () => {
    const fresh = await api.get<AgentModelsDto>(modelsPath(agent, account, true))
    queryClient.setQueryData(modelsKey(agent, account), fresh)
  }
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
