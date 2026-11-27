import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { AgentKind, StatusBarFormat, StatusBarItem, StatusBarWindows, UserSettingsDto } from '@sillage/protocol'
import { api } from './api'
import { USER_SETTINGS_KEY, useUserSettings } from './user-settings'

/**
 * The status line under the composer: what it can show, the default line, and the account's
 * choice. Presentation lives in `components/chat/status-bar`; live values in `status-data.ts`.
 */

export const STATUS_ITEM_KEYS = [
  'cli', 'quota', 'context', 'tokens', 'lastTurn', 'cost', 'agents', 'clock',
  'model', 'version', 'worktree', 'files', 'tools', 'previews', 'shortcuts',
] as const
export type StatusItemKey = (typeof STATUS_ITEM_KEYS)[number]

export interface StatusItemSpec {
  key: StatusItemKey
  /**
   * CLIs whose sessions report it, null for every CLI. Read from the adapters
   * (`apps/server/src/agents`) for Claude Code 2.1.332, Codex 0.172.0 and the other targets of
   * the same release: only the settings preview uses it. In a session an item without a value
   * hides by itself, whatever this says.
   */
  agents: AgentKind[] | null
  /** Formats a proportion can take, the first being the default. Absent: plain text. */
  formats?: StatusBarFormat[]
}

export const STATUS_ITEMS: StatusItemSpec[] = [
  { key: 'cli', agents: null },
  // OpenCode reports no account limits: it bills whatever provider it is pointed at.
  { key: 'quota', agents: ['claude', 'codex', 'copilot', 'grok', 'antigravity'], formats: ['bar', 'ring', 'text'] },
  { key: 'context', agents: null, formats: ['ring', 'bar', 'text'] },
  { key: 'tokens', agents: null },
  { key: 'lastTurn', agents: null },
  { key: 'cost', agents: null },
  // Sub-agents from Claude, Codex and OpenCode; background shells from Antigravity and Copilot.
  { key: 'agents', agents: ['claude', 'codex', 'opencode', 'antigravity', 'copilot'] },
  { key: 'clock', agents: null },
  { key: 'model', agents: null },
  // Only Claude Code names its version when a session starts.
  { key: 'version', agents: ['claude'] },
  { key: 'worktree', agents: null },
  { key: 'files', agents: null },
  { key: 'tools', agents: null },
  { key: 'previews', agents: null },
  { key: 'shortcuts', agents: null },
]

const SPECS = new Map(STATUS_ITEMS.map((spec) => [spec.key, spec]))

export function statusItemSpec(key: StatusItemKey): StatusItemSpec {
  return SPECS.get(key)!
}

/** An item as the line uses it: a known key, a format it accepts, the quota windows choice. */
export interface StatusItem {
  key: StatusItemKey
  on: boolean
  format: StatusBarFormat | null
  windows: StatusBarWindows
}

/**
 * The line before the account touches it: what replaced the old fixed row (CLI and session
 * state), plus the quota and tokens most asked about, and running agents, which hide when idle.
 */
export const DEFAULT_STATUS_BAR: StatusBarItem[] = [
  { key: 'cli', on: true },
  { key: 'quota', on: true, format: 'bar', windows: 'busiest' },
  { key: 'tokens', on: true },
  { key: 'agents', on: true },
  { key: 'shortcuts', on: true },
]

/**
 * Every catalog item exactly once, in the stored order: unknown keys (from a later or earlier
 * version) drop out, items added since the choice was saved come last, switched off.
 */
export function resolveStatusBar(stored: StatusBarItem[] | null | undefined): StatusItem[] {
  const seen = new Set<StatusItemKey>()
  const items: StatusItem[] = []
  for (const item of stored ?? DEFAULT_STATUS_BAR) {
    const spec = SPECS.get(item.key as StatusItemKey)
    if (!spec || seen.has(spec.key)) continue
    seen.add(spec.key)
    items.push({
      key: spec.key,
      on: item.on,
      format: spec.formats ? (item.format && spec.formats.includes(item.format) ? item.format : spec.formats[0]!) : null,
      windows: item.windows ?? 'busiest',
    })
  }
  for (const spec of STATUS_ITEMS) {
    if (!seen.has(spec.key)) items.push({ key: spec.key, on: false, format: spec.formats?.[0] ?? null, windows: 'busiest' })
  }
  return items
}

/** The stored form: no nulls, and only the fields an item uses. */
export function storeStatusBar(items: StatusItem[]): StatusBarItem[] {
  return items.map((item) => ({
    key: item.key,
    on: item.on,
    ...(item.format ? { format: item.format } : {}),
    ...(item.key === 'quota' ? { windows: item.windows } : {}),
  }))
}

/**
 * The account's line, and a way to change it. Applied immediately, like the composer layout: a
 * switch that takes a round trip to show its item would look broken. `null` restores the default.
 */
export function useStatusBar(): { items: StatusItem[]; customized: boolean; save: (items: StatusItem[] | null) => void } {
  const { data } = useUserSettings()
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: (statusBar: StatusBarItem[] | null) => api.patch<UserSettingsDto>('/api/me/settings', { statusBar }),
    onMutate: async (statusBar) => {
      await queryClient.cancelQueries({ queryKey: USER_SETTINGS_KEY })
      const previous = queryClient.getQueryData<UserSettingsDto>(USER_SETTINGS_KEY)
      if (previous) queryClient.setQueryData(USER_SETTINGS_KEY, { ...previous, statusBar })
      return { previous }
    },
    onError: (_error, _items, context) => {
      if (context?.previous) queryClient.setQueryData(USER_SETTINGS_KEY, context.previous)
    },
    onSuccess: (settings) => queryClient.setQueryData(USER_SETTINGS_KEY, settings),
  })
  const stored = data?.statusBar ?? null
  return {
    items: resolveStatusBar(stored),
    customized: stored !== null,
    save: (items) => mutation.mutate(items ? storeStatusBar(items) : null),
  }
}
