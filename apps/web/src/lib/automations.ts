import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  AutomationEvent,
  AutomationOperator,
  DeliveryReason,
  AutomationDeliveryDetailDto,
  AutomationDeliveryDto,
  AutomationTemplateId,
  WebhookAutomationDto,
  WebhookSettings,
  WebhookCall,
  WebhookTestResult,
} from '@sillage/protocol'
import { api } from './api'
import type { MessageKey, MessageParams } from './i18n'
import { SCHEDULES_KEY } from './schedules'

/**
 * Automation webhook: call log, settings, and secret. Task details (name, CLI, prompt) use
 * `lib/schedules` like scheduled tasks.
 */

const deliveriesKey = (taskId: string) => ['automation-deliveries', taskId]

/**
 * Poll the log while the page is open: users expect their first GitHub-triggered call to appear
 * without reload.
 */
export function useDeliveries(taskId: string) {
  return useQuery({
    queryKey: deliveriesKey(taskId),
    queryFn: () => api.get<AutomationDeliveryDto[]>(`/api/schedules/${taskId}/deliveries`),
    refetchInterval: 4_000,
  })
}

export function useDelivery(taskId: string, deliveryId: string | null) {
  return useQuery({
    queryKey: ['automation-delivery', taskId, deliveryId],
    queryFn: () => api.get<AutomationDeliveryDetailDto>(`/api/schedules/${taskId}/deliveries/${deliveryId}`),
    enabled: deliveryId !== null,
    staleTime: Infinity,
  })
}

/** Read secrets only on demand: do not leave them in the page cache. */
export function useRevealSecret(taskId: string) {
  return useMutation({
    mutationFn: () => api.get<{ secret: string }>(`/api/schedules/${taskId}/webhook/secret`),
  })
}

export function useRotateWebhook(taskId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<{ webhook: WebhookAutomationDto; secret: string }>(`/api/schedules/${taskId}/webhook/rotate`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: SCHEDULES_KEY }),
  })
}

export function useUpdateWebhook(taskId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (patch: Partial<WebhookSettings>) => api.patch<WebhookAutomationDto>(`/api/schedules/${taskId}/webhook`, patch),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: SCHEDULES_KEY }),
  })
}

export function useReplayDelivery(taskId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (deliveryId: string) =>
      api.post<{ delivery?: string; verdict: string }>(`/api/schedules/${taskId}/webhook/replay`, { deliveryId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: deliveriesKey(taskId) })
      void queryClient.invalidateQueries({ queryKey: SCHEDULES_KEY })
    },
  })
}

/**
 * Server-side trial of a test-bench call: only the server evaluates the script and session marker.
 * Launch nothing and write no log entry.
 */
export function useTestWebhook(taskId: string) {
  return useMutation({
    mutationFn: (input: { call: WebhookCall; settings: Partial<WebhookSettings>; prompt: string }) =>
      api.post<WebhookTestResult>(`/api/schedules/${taskId}/webhook/test`, input),
  })
}

export const TEMPLATE_LABELS: Record<AutomationTemplateId, { title: MessageKey; description: MessageKey; name: MessageKey }> = {
  github_issue_label: { title: 'automation.template.githubIssueLabel', description: 'automation.template.githubIssueLabelHint', name: 'automation.template.githubIssueLabelName' },
  github_comment_command: { title: 'automation.template.githubComment', description: 'automation.template.githubCommentHint', name: 'automation.template.githubCommentName' },
  github_pr_opened: { title: 'automation.template.githubPr', description: 'automation.template.githubPrHint', name: 'automation.template.githubPrName' },
  github_ci_failed: { title: 'automation.template.githubCi', description: 'automation.template.githubCiHint', name: 'automation.template.githubCiName' },
  gitlab_generic: { title: 'automation.template.gitlab', description: 'automation.template.gitlabHint', name: 'automation.template.gitlabName' },
}

/** Readable condition operators in selector order. */
export const OPERATOR_LABELS: { value: AutomationOperator; label: MessageKey }[] = [
  { value: 'equals', label: 'automation.op.equals' },
  { value: 'not_equals', label: 'automation.op.notEquals' },
  { value: 'contains', label: 'automation.op.contains' },
  { value: 'not_contains', label: 'automation.op.notContains' },
  { value: 'in', label: 'automation.op.in' },
  { value: 'matches', label: 'automation.op.matches' },
  { value: 'exists', label: 'automation.op.exists' },
  { value: 'missing', label: 'automation.op.missing' },
]

/** Server-signed curl command that would send this call for real. */
export function useWebhookCurl(taskId: string) {
  return useMutation({
    mutationFn: (input: { headers: Record<string, string>; body: string }) =>
      api.post<{ command: string }>(`/api/schedules/${taskId}/webhook/curl`, { ...input, origin: window.location.origin }),
  })
}

const REASON_KEYS: Record<DeliveryReason['code'], MessageKey> = {
  filter_rule: 'automation.reason.filterRule',
  filter_any: 'automation.reason.filterAny',
  unauthorized: 'automation.reason.unauthorized',
  duplicate: 'automation.reason.duplicate',
  paused: 'automation.reason.paused',
  tripped: 'automation.reason.tripped',
  archived: 'automation.reason.archived',
  busy: 'automation.reason.busy',
  coalesced: 'automation.reason.coalesced',
  circuit_open: 'automation.reason.circuitOpen',
  chain_depth: 'automation.reason.chainDepth',
  chain_rate: 'automation.reason.chainRate',
  script_skip: 'automation.reason.scriptSkip',
  script_timeout: 'automation.reason.scriptTimeout',
  script_memory: 'automation.reason.scriptMemory',
  script_contract: 'automation.reason.scriptContract',
  script_exception: 'automation.reason.scriptException',
  paused_in_queue: 'automation.reason.pausedInQueue',
  launch_failed: 'automation.reason.launchFailed',
  text: 'automation.reason.text',
}

/** Readable verdict reason in the UI language. */
export function describeReason(reason: DeliveryReason, t: (key: MessageKey, params?: MessageParams) => string): string {
  if (reason.code === 'script_skip' && !reason.params?.reason) return t('automation.reason.scriptSkipDefault')
  if (reason.code === 'filter_rule' && !reason.params?.actual) return t('automation.reason.filterRuleAbsent', reason.params)
  return t(REASON_KEYS[reason.code], reason.params)
}

/** Full address: without configured `publicUrl`, the server returns a relative URL. */
export function absoluteHookUrl(url: string): string {
  return url.startsWith('/') ? `${window.location.origin}${url}` : url
}

/** Headers written one per line as `name: value`, like an HTTP request. */
export function parseHeaders(text: string): { headers: Record<string, string>; invalid: number } {
  const headers: Record<string, string> = {}
  let invalid = 0
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    const at = line.indexOf(':')
    if (at <= 0) {
      invalid += 1
      continue
    }
    headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim()
  }
  return { headers, invalid }
}

/**
 * Received-call headers excluding transport additions (proxy, compression), which say nothing about
 * the call and obscure editable ones.
 */
const TRANSPORT_HEADERS = /^(host|content-length|connection|accept|accept-encoding|via|x-real-ip|x-forwarded-.*|cf-.*|cdn-loop|true-client-ip)$/

export function formatHeaders(headers: Record<string, string>): string {
  return Object.entries(headers)
    .filter(([name]) => !TRANSPORT_HEADERS.test(name))
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n')
}

/** Test-bench call as read by conditions and explorer, matching server construction. */
export function benchEvent(call: WebhookCall): AutomationEvent {
  let payload: unknown = null
  const trimmed = call.body.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      payload = JSON.parse(trimmed)
    } catch {
      payload = null
    }
  }
  return { headers: call.headers, query: {}, payload, body: call.body }
}
