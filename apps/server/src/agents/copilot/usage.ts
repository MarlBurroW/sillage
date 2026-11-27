import type { AgentUsage, UsageWindow } from '@sillage/protocol'
import { fields } from '../acp/content.js'

/**
 * Copilot's ACP has no quota call (`account.getQuota` belongs to its SDK protocol and answers
 * "Method not found" here, 1.0.116). The account's quota only arrives with each model call, as
 * `quotaSnapshots` of the `assistant.usage` session event: one snapshot per quota, shaped as the
 * CLI's `session-events.schema.json` describes (`AssistantUsageQuotaSnapshot`). The gauge is
 * therefore the last snapshot a turn reported, dated by that turn.
 *
 * Read from the schema, not observed: the probe ran against a model provider of its own, which
 * reports no quota. Only what the schema states is used, a count of requests against an
 * entitlement; a snapshot without both yields no window rather than a guessed percentage.
 */
export type CopilotQuota = Record<string, unknown>

const LABELS: Record<string, string> = {
  premium_interactions: 'Premium requests',
  chat: 'Chat',
  completions: 'Completions',
}

interface Snapshot { id: string; utilization: number; resetsAt: number | null; overage: boolean }

function snapshots(quota: CopilotQuota): Snapshot[] {
  return Object.entries(quota).flatMap(([id, raw]) => {
    const snapshot = fields(raw)
    if (snapshot.isUnlimitedEntitlement === true || snapshot.hasQuota === false) return []
    const entitlement = Number(snapshot.entitlementRequests), used = Number(snapshot.usedRequests)
    if (!(entitlement > 0) || !Number.isFinite(used)) return []
    const reset = typeof snapshot.resetDate === 'string' ? Date.parse(snapshot.resetDate) : NaN
    return [{
      id,
      utilization: Math.min(1, Math.max(0, used / entitlement)),
      resetsAt: Number.isFinite(reset) ? reset : null,
      overage: snapshot.overageAllowedWithExhaustedQuota === true || snapshot.usageAllowedWithExhaustedQuota === true,
    }]
  })
}

export function quotaWindows(quota: CopilotQuota): UsageWindow[] {
  return snapshots(quota).map(({ id, utilization, resetsAt }) => ({ id, label: LABELS[id] ?? id.replaceAll('_', ' '), utilization, resetsAt }))
}

export interface CopilotLimit { type: string; status: 'allowed' | 'allowed_warning' | 'rejected'; utilization: number | null; resetsAt: number | null; overageEnabled?: boolean }

/**
 * The quota closest to its limit, as the live rate limit of a conversation. A full quota is only
 * a warning here: Copilot may keep answering with included models or paid overage, and a
 * rejection would make Sillage schedule a resume. Only a refused request says the account is
 * stopped; see `refusedLimit`.
 */
export function quotaLimit(quota: CopilotQuota): CopilotLimit | null {
  const [worst] = snapshots(quota).sort((a, b) => b.utilization - a.utilization)
  if (!worst) return null
  return { type: worst.id, status: worst.utilization >= 0.9 ? 'allowed_warning' : 'allowed', utilization: worst.utilization, resetsAt: worst.resetsAt, overageEnabled: worst.overage }
}

/**
 * Copilot refused a request for its quota or a rate limit (`session.error`). The plan's quota
 * names its own reset; a rate limit has other windows Copilot only describes in its message, so
 * its reset stays unknown rather than borrowed.
 */
export function refusedLimit(errorType: string, last: CopilotLimit | null): CopilotLimit {
  if (errorType === 'quota' && last) return { ...last, status: 'rejected' }
  return { type: errorType, status: 'rejected', utilization: null, resetsAt: null }
}

/** No snapshot yet (no turn since the server started), or a plan without quotas: nothing to show, not a failure. */
export function copilotUsage(observed: { quota: CopilotQuota; at: number } | null): AgentUsage {
  const windows = observed ? quotaWindows(observed.quota) : []
  return { agent: 'copilot', plan: null, limitsAvailable: windows.length > 0, windows, credits: null, fetchedAt: observed?.at ?? Date.now() }
}
