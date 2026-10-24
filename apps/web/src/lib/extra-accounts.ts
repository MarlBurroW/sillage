import { useAntigravityAccounts, useCreateAntigravityAccount } from './antigravity-accounts'
import { useEffect, useState } from 'react'
import type { CodexAccount, GrokAccount, AntigravityAccount } from '@sillage/protocol'
import { useClaudeAccounts } from './claude-accounts'
import { useCodexAccounts, useCreateCodexAccount } from './codex-accounts'
import { useCreateGrokAccount, useGrokAccounts } from './grok-accounts'
import { useUpdateAgentDefault, useUserSettings } from './user-settings'

/**
 * Additional CLI accounts for screens outside settings. Supplies logic and data only: a common
 * account list, the account opened for connection, and adoption of the first added account for
 * new conversations. Callers choose presentation; onboarding needs badges rather than renameable
 * cards. Addition differs: Claude creates accounts after its form (pasted token or guided login),
 * while the other CLIs create them first and log in within their private home.
 */
export type ExtraAccountAgent = 'claude' | 'codex' | 'grok' | 'antigravity'

export interface ExtraAccountSummary {
  id: string
  label: string
  /** Connected and usable. Claude accounts are connected upon creation. */
  ready: boolean
  /** Account used by this CLI's new conversations. */
  isDefault: boolean
}

export function useExtraAccounts(
  agent: ExtraAccountAgent,
  options: {
    /**
     * Use the first account added here for new conversations. Useful when the CLI itself appears
     * disconnected, avoiding an absent default login. Disable when already connected to preserve
     * its choice.
     */
    adoptAsDefault: boolean
    /** Name given to the account created by `begin`. */
    defaultLabel: string
  },
) {
  // Call all hooks with only one active: hooks cannot be selected conditionally.
  const claude = useClaudeAccounts(agent === 'claude')
  const codex = useCodexAccounts(agent === 'codex')
  const grok = useGrokAccounts(agent === 'grok')
  const createCodex = useCreateCodexAccount()
  const antigravity = useAntigravityAccounts(agent === 'antigravity')
  const createAntigravity = useCreateAntigravityAccount()
  const createGrok = useCreateGrokAccount()
  const { data: settings } = useUserSettings()
  const updateDefault = useUpdateAgentDefault()

  const defaults = settings?.agentDefaults[agent]
  const raw = agent === 'claude' ? claude.data?.accounts : agent === 'codex' ? codex.data?.accounts : agent === 'grok' ? grok.data?.accounts : antigravity.data?.accounts
  const accounts: ExtraAccountSummary[] = (raw ?? []).map((account) => ({
    id: account.id,
    label: account.label,
    ready: 'status' in account ? account.status === 'ready' : true,
    isDefault: defaults?.account === account.id,
  }))

  // Accounts present on entry were not added here.
  const [known, setKnown] = useState<Set<string> | null>(null)
  useEffect(() => {
    if (raw && known === null) setKnown(new Set(raw.map((account) => account.id)))
  }, [raw, known])
  const firstAdded = known ? (accounts.find((account) => !known.has(account.id) && account.ready)?.id ?? null) : null

  useEffect(() => {
    if (!options.adoptAsDefault || !defaults || defaults.account !== null || !firstAdded || updateDefault.isPending) return
    updateDefault.mutate({ ...defaults, account: firstAdded })
  }, [options.adoptAsDefault, defaults, firstAdded, updateDefault])

  const [openedId, setOpenedId] = useState<string | null>(null)
  const codexOpened: CodexAccount | null = agent === 'codex' ? (codex.data?.accounts.find((account) => account.id === openedId) ?? null) : null
  const grokOpened: GrokAccount | null = agent === 'grok' ? (grok.data?.accounts.find((account) => account.id === openedId) ?? null) : null

  const antigravityOpened: AntigravityAccount | null = agent === 'antigravity' ? (antigravity.data?.accounts.find((account) => account.id === openedId) ?? null) : null

  const begin = () => {
    if (agent === 'antigravity') createAntigravity.mutate({ label: options.defaultLabel }, { onSuccess: (account) => setOpenedId(account.id) })
    if (agent === 'codex') createCodex.mutate({ label: options.defaultLabel }, { onSuccess: (account) => setOpenedId(account.id) })
    if (agent === 'grok') createGrok.mutate({ label: options.defaultLabel }, { onSuccess: (account) => setOpenedId(account.id) })
  }

  return {
    accounts,
    /** Account added on this screen once connected, otherwise null. */
    firstAdded,
    codexOpened,
    grokOpened,
    antigravityOpened,
    /** Create the account to connect. Claude uses its own form. */
    begin,
    creating: createCodex.isPending || createGrok.isPending || createAntigravity.isPending,
    close: () => setOpenedId(null),
  }
}
