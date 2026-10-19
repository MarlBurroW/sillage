import { useEffect, useState } from 'react'
import type { CodexAccount, GrokAccount } from '@sillage/protocol'
import { useClaudeAccounts } from './claude-accounts'
import { useCodexAccounts, useCreateCodexAccount } from './codex-accounts'
import { useCreateGrokAccount, useGrokAccounts } from './grok-accounts'
import { useUpdateAgentDefault, useUserSettings } from './user-settings'

/**
 * Les comptes supplémentaires d'un CLI, vus d'un écran qui n'est pas celui des réglages.
 *
 * La logique et les données seulement : la liste sous une forme commune aux trois CLI, le
 * compte que l'on vient d'ouvrir pour le connecter, et l'adoption du premier compte ajouté
 * comme compte des nouvelles conversations. La présentation reste à l'appelant, qui n'a
 * pas les mêmes besoins que la page de réglages : la visite montre des badges, pas des
 * cartes à renommer.
 *
 * Les trois CLI n'ont pas le même chemin d'ajout. Claude crée le compte à la fin de son
 * formulaire (jeton collé ou connexion guidée) ; Codex et Grok créent le compte d'abord,
 * puis le connectent dans son home. D'où `begin`, qui ne fait quelque chose que pour ces
 * deux-là, et `codexOpened` / `grokOpened`, le compte à connecter.
 */
export type ExtraAccountAgent = 'claude' | 'codex' | 'grok'

export interface ExtraAccountSummary {
  id: string
  label: string
  /** Connecté, donc utilisable. Un compte Claude l'est dès sa création. */
  ready: boolean
  /** Celui que les nouvelles conversations de ce CLI prennent. */
  isDefault: boolean
}

export function useExtraAccounts(
  agent: ExtraAccountAgent,
  options: {
    /**
     * Prendre le premier compte ajouté ici comme compte des nouvelles conversations.
     * Utile quand le CLI lui-même n'a pas l'air connecté : sans ça, elles partiraient sur
     * une connexion absente. À couper quand le CLI est connecté, pour ne rien changer.
     */
    adoptAsDefault: boolean
    /** Nom donné au compte que `begin` crée. */
    defaultLabel: string
  },
) {
  // Tous appelés, un seul actif : les hooks ne se choisissent pas selon une condition.
  const claude = useClaudeAccounts(agent === 'claude')
  const codex = useCodexAccounts(agent === 'codex')
  const grok = useGrokAccounts(agent === 'grok')
  const createCodex = useCreateCodexAccount()
  const createGrok = useCreateGrokAccount()
  const { data: settings } = useUserSettings()
  const updateDefault = useUpdateAgentDefault()

  const defaults = settings?.agentDefaults[agent]
  const raw = agent === 'claude' ? claude.data?.accounts : agent === 'codex' ? codex.data?.accounts : grok.data?.accounts
  const accounts: ExtraAccountSummary[] = (raw ?? []).map((account) => ({
    id: account.id,
    label: account.label,
    ready: 'status' in account ? account.status === 'ready' : true,
    isDefault: defaults?.account === account.id,
  }))

  // Les comptes présents à l'arrivée ne sont pas « ajoutés ici ».
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

  const begin = () => {
    if (agent === 'codex') createCodex.mutate({ label: options.defaultLabel }, { onSuccess: (account) => setOpenedId(account.id) })
    if (agent === 'grok') createGrok.mutate({ label: options.defaultLabel }, { onSuccess: (account) => setOpenedId(account.id) })
  }

  return {
    accounts,
    /** Le compte ajouté pendant cet écran, une fois connecté ; null sinon. */
    firstAdded,
    codexOpened,
    grokOpened,
    /** Crée le compte à connecter (Codex, Grok). Claude passe par son propre formulaire. */
    begin,
    creating: createCodex.isPending || createGrok.isPending,
    close: () => setOpenedId(null),
  }
}
