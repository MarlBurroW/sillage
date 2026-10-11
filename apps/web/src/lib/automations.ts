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
 * Le webhook d'une automatisation : son journal d'appels, ses réglages, son secret.
 * La tâche elle-même (nom, CLI, prompt) passe par `lib/schedules`, comme une planifiée.
 */

const deliveriesKey = (taskId: string) => ['automation-deliveries', taskId]

/**
 * Le journal, relu souvent tant que la page est ouverte : on y attend le premier appel
 * qu'on vient de provoquer depuis GitHub, et il doit apparaître sans recharger.
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

/** Le secret ne se lit qu'à la demande : il n'a pas à traîner dans le cache de la page. */
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
 * Essai côté serveur d'un appel du banc : le script et la marque de session ne
 * s'évaluent que là. Rien n'est lancé ni écrit au journal.
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

/** Les opérateurs de condition en clair, dans l'ordre du sélecteur. */
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

/** La commande curl qui enverrait cet appel pour de vrai, signée par le serveur. */
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

/** La raison d'un verdict en clair, dans la langue de l'interface. */
export function describeReason(reason: DeliveryReason, t: (key: MessageKey, params?: MessageParams) => string): string {
  if (reason.code === 'script_skip' && !reason.params?.reason) return t('automation.reason.scriptSkipDefault')
  if (reason.code === 'filter_rule' && !reason.params?.actual) return t('automation.reason.filterRuleAbsent', reason.params)
  return t(REASON_KEYS[reason.code], reason.params)
}

/** L'adresse complète : sans `publicUrl` configurée, le serveur la rend relative. */
export function absoluteHookUrl(url: string): string {
  return url.startsWith('/') ? `${window.location.origin}${url}` : url
}

/** En-têtes écrits un par ligne, `nom: valeur`, comme dans une requête HTTP. */
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
 * En-têtes d'un appel reçu, sans ceux que le transport a ajoutés (proxy, compression) :
 * ils ne disent rien de l'appel et noieraient ceux qu'on vient modifier.
 */
const TRANSPORT_HEADERS = /^(host|content-length|connection|accept|accept-encoding|via|x-real-ip|x-forwarded-.*|cf-.*|cdn-loop|true-client-ip)$/

export function formatHeaders(headers: Record<string, string>): string {
  return Object.entries(headers)
    .filter(([name]) => !TRANSPORT_HEADERS.test(name))
    .map(([name, value]) => `${name}: ${value}`)
    .join('\n')
}

/** L'appel du banc tel que conditions et explorateur le lisent, comme le serveur le construit. */
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
