import type { AgentUsage, UsageWindow } from '@sillage/protocol'
import { fields } from '../acp/content.js'

/**
 * Copilot's ACP has no quota call (`account.getQuota` belongs to its SDK protocol and answers
 * "Method not found" here, 1.0.116), and `/usage` over ACP only prints the session's own spend.
 * The account's quota only arrives with each model call, as `quotaSnapshots` of the
 * `assistant.usage` session event. The gauge is therefore the last snapshot a turn reported,
 * dated by that turn.
 *
 * Observed on a signed-in account billed in AI credits (1.0.116), three snapshots:
 * - `chat` is the plan's monthly budget (200 credits there). Its `remainingPercentage` went down
 *   with every model call of a CLI turn, by that call's credits; `usedRequests` is the same
 *   amount rounded to a whole number, too coarse to show a turn.
 * - `completions` counts the editor's inline completions. CLI turns never moved it.
 * - `premium_interactions` had an entitlement of zero. On a plan billed in premium requests it
 *   is what a prompt spends (`copilot help billing`); that was not available to observe.
 * A snapshot reflects the account before the call that carries it.
 */
export type CopilotQuota = Record<string, unknown>

/** The quotas a CLI turn spends. */
const SPENT = ['premium_interactions', 'chat']

interface Snapshot { id: string; utilization: number; resetsAt: number | null; overage: boolean }

function snapshots(quota: CopilotQuota): Snapshot[] {
  return SPENT.flatMap((id) => {
    const snapshot = fields(quota[id])
    if (snapshot.isUnlimitedEntitlement === true || snapshot.hasQuota === false) return []
    const entitlement = Number(snapshot.entitlementRequests), used = Number(snapshot.usedRequests)
    // No entitlement is a quota the plan does not have, not one that is used up.
    if (!(entitlement > 0)) return []
    const remaining = typeof snapshot.remainingPercentage === 'number' ? snapshot.remainingPercentage : NaN
    const spent = remaining >= 0 && remaining <= 100 ? 1 - remaining / 100 : used / entitlement
    if (!Number.isFinite(spent)) return []
    const reset = typeof snapshot.resetDate === 'string' ? Date.parse(snapshot.resetDate) : NaN
    return [{
      id,
      utilization: Math.round(Math.min(1, Math.max(0, spent)) * 10_000) / 10_000,
      resetsAt: Number.isFinite(reset) ? reset : null,
      overage: snapshot.overageAllowedWithExhaustedQuota === true || snapshot.usageAllowedWithExhaustedQuota === true,
    }]
  })
}

/** `credits`: the account is billed in AI credits, which is then what its `chat` budget counts. */
export function quotaWindows(quota: CopilotQuota, credits: boolean): UsageWindow[] {
  const label = (id: string) => (id === 'premium_interactions' ? 'Premium requests' : credits ? 'AI credits' : 'Chat')
  return snapshots(quota).map(({ id, utilization, resetsAt }) => ({ id, label: label(id), utilization, resetsAt }))
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

export interface ObservedQuota { quota: CopilotQuota; credits: boolean; at: number }

/** No snapshot yet (no turn since the server started), or a plan without quotas: nothing to show, not a failure. */
export function copilotUsage(observed: ObservedQuota | null): AgentUsage {
  const windows = observed ? quotaWindows(observed.quota, observed.credits) : []
  return { agent: 'copilot', plan: null, limitsAvailable: windows.length > 0, windows, credits: null, fetchedAt: observed?.at ?? Date.now() }
}
