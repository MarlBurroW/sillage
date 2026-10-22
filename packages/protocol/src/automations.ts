import { z } from 'zod'

/**
 * Webhook-triggered automations: an incoming HTTP call opens a fresh session, like a
 * scheduled-task run, using the same engine.
 *
 * The engine knows no service: it receives headers and a body, evaluates conditions and an
 * optional script, then returns a prompt. GitHub and GitLab are merely presets
 * (`AUTOMATION_TEMPLATES`).
 *
 * Path reading, conditions and prompt rendering live here rather than on the server: the UI
 * evaluates them live against received calls, and a displayed verdict differing from the
 * applied one would make the tester useless.
 */

export const MAX_AUTOMATION_RULES = 30
export const MAX_AUTOMATION_SCRIPT_CHARS = 20000
export const MAX_AUTOMATION_PATH_CHARS = 300
export const MAX_AUTOMATION_VALUE_CHARS = 1000
/** Beyond this, a runaway trigger pauses itself. */
export const DEFAULT_AUTOMATION_RUNS_PER_HOUR = 10
export const MAX_AUTOMATION_RUNS_PER_HOUR = 120
/** Largest body retained in the journal; larger calls are accepted but truncated. */
export const MAX_DELIVERY_BODY_BYTES = 256 * 1024

// --- Paths and templates -------------------------------------------------------------

/**
 * Value at a dotted path: `payload.issue.title`, `payload.commits.0.id`,
 * `headers.x-github-event`. A `*` segment traverses an array or object values and returns all
 * results: `payload.issue.labels.*.name` yields every label name, which no fixed index could
 * provide.
 */
export function readPath(root: unknown, path: string): unknown {
  const segments = path.split('.').map((segment) => segment.trim()).filter(Boolean)
  let current: unknown[] = [root]
  let spread = false
  for (const segment of segments) {
    const next: unknown[] = []
    for (const value of current) {
      if (value === null || typeof value !== 'object') continue
      if (segment === '*') {
        spread = true
        next.push(...(Array.isArray(value) ? value : Object.values(value)))
      } else if (Object.prototype.hasOwnProperty.call(value, segment)) {
        next.push((value as Record<string, unknown>)[segment])
      }
    }
    current = next
  }
  if (spread) return current
  return current.length > 0 ? current[0] : undefined
}

/** Text representation for a prompt or comparison: objects become JSON. */
export function valueText(value: unknown, pretty = false): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value, null, pretty ? 2 : undefined) ?? ''
}

/** Beyond this, a full `{{payload}}` would displace instructions from agent context. */
const MAX_RENDERED_VALUE_CHARS = 20000

const PLACEHOLDER = /\{\{\s*([\w.*-]+)\s*\}\}/g

/**
 * Replaces template `{{path}}` placeholders with values from `scope`. Missing paths become
 * empty strings, except with `keepMissing`, which retains the marker: the preview uses this to
 * make typos visible instead of hiding them.
 */
export function renderTemplate(
  template: string,
  scope: Record<string, unknown>,
  options: { keepMissing?: boolean } = {},
): string {
  return template.replace(PLACEHOLDER, (whole, path: string) => {
    const value = readPath(scope, path)
    if (value === undefined && options.keepMissing) return whole
    const text = valueText(value, true)
    return text.length > MAX_RENDERED_VALUE_CHARS ? `${text.slice(0, MAX_RENDERED_VALUE_CHARS)}…` : text
  })
}

/** Paths referenced by a template, used to flag those missing from the sample call. */
export function templatePaths(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((match) => match[1]!)
}

// --- Event ---------------------------------------------------------------------------

/**
 * What conditions, scripts and prompts see from a call. Headers are lowercase, matching HTTP
 * handling; `payload` is null for non-JSON bodies, with `body` retaining raw text.
 */
export interface AutomationEvent {
  headers: Record<string, string>
  query: Record<string, string>
  payload: unknown
  body: string
}

// --- Conditions ----------------------------------------------------------------------

export const automationOperatorSchema = z.enum([
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'in',
  'matches',
  'exists',
  'missing',
])
export type AutomationOperator = z.infer<typeof automationOperatorSchema>

export const automationRuleSchema = z.object({
  path: z.string().trim().min(1).max(MAX_AUTOMATION_PATH_CHARS),
  op: automationOperatorSchema,
  value: z.string().max(MAX_AUTOMATION_VALUE_CHARS).default(''),
})
export type AutomationRule = z.infer<typeof automationRuleSchema>

export const automationConditionsSchema = z.object({
  mode: z.enum(['all', 'any']).default('all'),
  rules: z.array(automationRuleSchema).max(MAX_AUTOMATION_RULES).default([]),
})
export type AutomationConditions = z.infer<typeof automationConditionsSchema>

/** Operators that do not read a value, allowing the form to hide that field. */
export const VALUELESS_OPERATORS: readonly AutomationOperator[] = ['exists', 'missing']

export interface RuleResult {
  ok: boolean
  /** Resolved path value, displayed next to ✓ or ✗. */
  actual: unknown
  /** Invalid regex: the rule fails and the form explains why. */
  error?: string
}

/**
 * A rule on a list (`*` path) succeeds if any element matches, except negations, which require
 * none to match: “label is not `wip`” must be false as soon as any label is `wip`.
 */
export function evaluateRule(rule: AutomationRule, event: AutomationEvent): RuleResult {
  const actual = readPath(event, rule.path)
  const values = Array.isArray(actual) ? actual : [actual]
  const present = values.filter((value) => value !== undefined && value !== null)

  if (rule.op === 'exists') return { ok: present.length > 0, actual }
  if (rule.op === 'missing') return { ok: present.length === 0, actual }

  if (rule.op === 'matches') {
    let pattern: RegExp
    try {
      pattern = new RegExp(rule.value, 'i')
    } catch (err) {
      return { ok: false, actual, error: err instanceof Error ? err.message : String(err) }
    }
    return { ok: present.some((value) => pattern.test(valueText(value))), actual }
  }

  const expected = rule.value
  const equals = (value: unknown) => valueText(value) === expected
  const contains = (value: unknown) =>
    Array.isArray(value) ? value.some((item) => valueText(item) === expected) : valueText(value).includes(expected)

  if (rule.op === 'equals') return { ok: present.some(equals), actual }
  if (rule.op === 'not_equals') return { ok: !present.some(equals), actual }
  if (rule.op === 'contains') return { ok: present.some(contains), actual }
  if (rule.op === 'not_contains') return { ok: !present.some(contains), actual }
  // `in`: one value per line or comma-separated.
  const choices = expected.split(/[\n,]/).map((choice) => choice.trim()).filter(Boolean)
  return { ok: present.some((value) => choices.includes(valueText(value))), actual }
}

export function evaluateConditions(
  conditions: AutomationConditions,
  event: AutomationEvent,
): { ok: boolean; results: RuleResult[] } {
  const results = conditions.rules.map((rule) => evaluateRule(rule, event))
  if (results.length === 0) return { ok: true, results }
  const ok = conditions.mode === 'all' ? results.every((result) => result.ok) : results.some((result) => result.ok)
  return { ok, results }
}

// --- Caller verification -------------------------------------------------------------

const headerName = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9-]{1,100}$/, { message: 'An HTTP header name.' })

/**
 * How to verify a call comes from the expected service. The URL is already secret, but appears
 * in proxy or CI logs: the signature prevents the URL alone from being enough to launch agents.
 */
export const webhookVerificationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  /** Raw secret in a header (GitLab: `x-gitlab-token`). */
  z.object({ kind: z.literal('token'), header: headerName }),
  /** HMAC of the raw body (GitHub: `x-hub-signature-256`, `sha256=`). */
  z.object({
    kind: z.literal('hmac'),
    header: headerName,
    algorithm: z.enum(['sha256', 'sha1']),
    prefix: z.string().max(20),
  }),
])
export type WebhookVerification = z.infer<typeof webhookVerificationSchema>

// --- Webhook configuration -----------------------------------------------------------

export const webhookSettingsSchema = z.object({
  verification: webhookVerificationSchema,
  /** Header identifying a delivery to ignore replays; empty for none. */
  deliveryHeader: z.union([headerName, z.literal('')]),
  conditions: automationConditionsSchema,
  script: z.string().max(MAX_AUTOMATION_SCRIPT_CHARS),
  /**
   * Path identifying the call's subject (issue, PR, branch): pending calls on the same subject
   * are merged, with the latest winning.
   */
  subjectPath: z.string().trim().max(MAX_AUTOMATION_PATH_CHARS),
  /**
   * Comma-separated paths to search for a Sillage session marker; `*` for the entire body,
   * empty to skip searching. A found marker attributes the launch to that session, including
   * its chain limits.
   */
  markerPaths: z.string().trim().max(MAX_AUTOMATION_PATH_CHARS * 3),
  maxRunsPerHour: z.number().int().min(1).max(MAX_AUTOMATION_RUNS_PER_HOUR),
})
export type WebhookSettings = z.infer<typeof webhookSettingsSchema>

export const DEFAULT_WEBHOOK_SETTINGS: WebhookSettings = {
  verification: { kind: 'none' },
  deliveryHeader: '',
  conditions: { mode: 'all', rules: [] },
  script: '',
  subjectPath: '',
  markerPaths: '*',
  maxRunsPerHour: DEFAULT_AUTOMATION_RUNS_PER_HOUR,
}

export const updateWebhookSettingsBodySchema = webhookSettingsSchema.partial()

// --- Delivery journal ----------------------------------------------------------------

/**
 * Outcome of an incoming call. Each rejection has its own: a trigger that never launches must
 * say whether its signature, conditions or circuit breaker blocked it.
 */
export const deliveryVerdictSchema = z.enum([
  'launched',
  'queued',
  'coalesced',
  'busy',
  'filtered',
  'script_skipped',
  'script_error',
  'duplicate',
  'unauthorized',
  'chain_refused',
  'circuit_open',
  'disabled',
  'launch_failed',
])
export type DeliveryVerdict = z.infer<typeof deliveryVerdictSchema>

/**
 * Why a call did not launch a session, as a code and parameters: the server does not know the
 * user's language; the UI turns it into a sentence. `text` retains a free-form script message
 * (`{ skip: '…' }`) or error.
 */
export const DELIVERY_REASON_CODES = [
  'filter_rule',
  'filter_any',
  'unauthorized',
  'duplicate',
  'paused',
  'tripped',
  'archived',
  'busy',
  'coalesced',
  'circuit_open',
  'chain_depth',
  'chain_rate',
  'script_skip',
  'script_timeout',
  'script_memory',
  'script_contract',
  'script_exception',
  'paused_in_queue',
  'launch_failed',
  'text',
] as const
export type DeliveryReasonCode = (typeof DELIVERY_REASON_CODES)[number]

export interface DeliveryReason {
  code: DeliveryReasonCode
  params?: Record<string, string | number>
}

export interface AutomationDeliveryDto {
  id: string
  taskId: string
  receivedAt: number
  /** Caller-provided ID (`x-github-delivery`), if any. */
  deliveryId: string | null
  verdict: DeliveryVerdict
  reason: DeliveryReason | null
  subject: string | null
  conversationId: string | null
  /** Session whose marker was found in the call. */
  originConversationId: string | null
  /** Readable summary: GitHub event and action, when available. */
  summary: string | null
  bytes: number
  truncated: boolean
}

export interface AutomationDeliveryDetailDto extends AutomationDeliveryDto {
  event: AutomationEvent
}

export interface WebhookAutomationDto extends WebhookSettings {
  taskId: string
  url: string
  /** Circuit breaker tripped: the task is paused until reactivated. */
  trippedAt: number | null
  /** Original template for contextual help; null for generic webhooks. */
  template: AutomationTemplateId | null
}

/** Validated script result. */
export const scriptDecisionSchema = z.union([
  z.null(),
  z.literal(false),
  z.object({ skip: z.string().max(500) }),
  z.object({
    subject: z.union([z.string(), z.number()]).optional(),
    vars: z.record(z.string(), z.unknown()).optional(),
  }),
])

/** A call entered on the page: headers and raw body, as they would arrive. */
export const webhookCallSchema = z.object({
  headers: z.record(z.string(), z.string()).default({}),
  body: z.string().max(MAX_DELIVERY_BODY_BYTES),
})
export type WebhookCall = z.infer<typeof webhookCallSchema>

/**
 * Tests configuration without launching or writing anything: using a journal call
 * (`deliveryId`) or one entered in the test bench (`call`).
 */
export const testWebhookBodySchema = z
  .object({
    deliveryId: z.string().min(1).optional(),
    call: webhookCallSchema.optional(),
    /** Settings currently being edited, not yet saved. */
    settings: webhookSettingsSchema.partial().optional(),
    prompt: z.string().max(20000).optional(),
  })
  .refine((body) => Boolean(body.deliveryId) !== Boolean(body.call), { message: 'Give either deliveryId or call.' })

/** Actually replay a call from the journal. */
export const replayWebhookBodySchema = z.object({ deliveryId: z.string().min(1) })

export interface WebhookTestResult {
  verdict: 'launch' | 'filtered' | 'script_skipped' | 'script_error'
  conditions: RuleResult[]
  script: { ran: boolean; error: DeliveryReason | null; result: unknown; durationMs: number; logs: string[] }
  subject: string | null
  vars: Record<string, unknown>
  /** Automation prompt rendered with this call; absent fields retain their `{{…}}` markers. */
  prompt: string
  /** Complete first message the session would receive, including Sillage's header. */
  message: string
  reason: DeliveryReason | null
  originConversationId: string | null
}

/** curl command that would send a real call. */
export const webhookCurlBodySchema = webhookCallSchema.extend({
  /** Page origin, to form a full address when `publicUrl` is unset. */
  origin: z.string().max(300).optional(),
})

// --- Session marker ------------------------------------------------------------------

/**
 * What agents leave in content written to a forge: an invisible HTML comment in an issue or PR,
 * or a trailer in a commit message.
 */
export function sessionMarker(conversationId: string): string {
  return `<!-- sillage:session=${conversationId} -->`
}
export function sessionTrailer(conversationId: string): string {
  return `Sillage-Session: ${conversationId}`
}

const MARKER = /(?:<!--\s*sillage:session=|Sillage-Session:\s*)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi

/** Sessions whose markers appear in a text, in order of appearance. */
export function findSessionMarkers(text: string): string[] {
  return [...new Set([...text.matchAll(MARKER)].map((match) => match[1]!.toLowerCase()))]
}

/** Text to search for markers, according to `markerPaths`. */
export function markerText(event: AutomationEvent, markerPaths: string): string {
  const paths = markerPaths.split(',').map((path) => path.trim()).filter(Boolean)
  if (paths.includes('*')) return event.body
  return paths.map((path) => valueText(readPath(event, path))).join('\n')
}

// --- Templates -----------------------------------------------------------------------

export const automationTemplateIdSchema = z.enum([
  'github_issue_label',
  'github_comment_command',
  'github_pr_opened',
  'github_ci_failed',
  'gitlab_generic',
])
export type AutomationTemplateId = z.infer<typeof automationTemplateIdSchema>

export interface AutomationTemplate {
  id: AutomationTemplateId
  settings: WebhookSettings
  /** Prefilled prompt in French and English: the agent reads what the user writes. */
  prompt: { fr: string; en: string }
}

const GITHUB_HMAC: WebhookVerification = { kind: 'hmac', header: 'x-hub-signature-256', algorithm: 'sha256', prefix: 'sha256=' }

function github(
  rules: AutomationRule[],
  subjectPath: string,
  markerPaths: string,
): WebhookSettings {
  return {
    ...DEFAULT_WEBHOOK_SETTINGS,
    verification: GITHUB_HMAC,
    deliveryHeader: 'x-github-delivery',
    conditions: { mode: 'all', rules },
    subjectPath,
    markerPaths,
  }
}

/**
 * Ready-to-use templates. The first two start with a human action (a label, a command), the
 * safest pattern against chains: agents are instructed never to add that label or write that
 * command.
 */
export const AUTOMATION_TEMPLATES: readonly AutomationTemplate[] = [
  {
    id: 'github_issue_label',
    settings: github(
      [
        { path: 'headers.x-github-event', op: 'equals', value: 'issues' },
        { path: 'payload.action', op: 'equals', value: 'labeled' },
        { path: 'payload.label.name', op: 'equals', value: 'sillage' },
      ],
      'payload.issue.number',
      // A person adds the label: the marker of the agent who wrote the issue
      // says nothing about who triggered it.
      '',
    ),
    prompt: {
      fr: "Traite l'issue #{{payload.issue.number}} « {{payload.issue.title}} » du dépôt {{payload.repository.full_name}} ({{payload.issue.html_url}}).\n\n{{payload.issue.body}}\n\nTravaille sur une branche dédiée, puis ouvre une pull request qui référence l'issue.",
      en: 'Handle issue #{{payload.issue.number}} "{{payload.issue.title}}" in {{payload.repository.full_name}} ({{payload.issue.html_url}}).\n\n{{payload.issue.body}}\n\nWork on a dedicated branch, then open a pull request that references the issue.',
    },
  },
  {
    id: 'github_comment_command',
    settings: github(
      [
        { path: 'headers.x-github-event', op: 'equals', value: 'issue_comment' },
        { path: 'payload.action', op: 'equals', value: 'created' },
        { path: 'payload.comment.body', op: 'matches', value: '^/sillage\\b' },
      ],
      'payload.issue.number',
      'payload.comment.body',
    ),
    prompt: {
      fr: '{{payload.comment.user.login}} demande, sur {{payload.issue.html_url}} (« {{payload.issue.title}} ») :\n\n{{payload.comment.body}}\n\nRéponds par un commentaire sur la même issue ou pull request quand tu as fini.',
      en: '{{payload.comment.user.login}} asks, on {{payload.issue.html_url}} ("{{payload.issue.title}}"):\n\n{{payload.comment.body}}\n\nReply with a comment on the same issue or pull request when you are done.',
    },
  },
  {
    id: 'github_pr_opened',
    settings: github(
      [
        { path: 'headers.x-github-event', op: 'equals', value: 'pull_request' },
        { path: 'payload.action', op: 'in', value: 'opened, reopened, ready_for_review' },
        { path: 'payload.pull_request.draft', op: 'equals', value: 'false' },
      ],
      'payload.pull_request.number',
      'payload.pull_request.body',
    ),
    prompt: {
      fr: 'Relis la pull request #{{payload.pull_request.number}} « {{payload.pull_request.title}} » ({{payload.pull_request.html_url}}), branche {{payload.pull_request.head.ref}} vers {{payload.pull_request.base.ref}}.\n\n{{payload.pull_request.body}}\n\nLaisse une revue sur la PR : ce qui bloque, puis ce qui peut attendre.',
      en: 'Review pull request #{{payload.pull_request.number}} "{{payload.pull_request.title}}" ({{payload.pull_request.html_url}}), branch {{payload.pull_request.head.ref}} into {{payload.pull_request.base.ref}}.\n\n{{payload.pull_request.body}}\n\nLeave a review on the PR: blockers first, then what can wait.',
    },
  },
  {
    id: 'github_ci_failed',
    settings: github(
      [
        { path: 'headers.x-github-event', op: 'equals', value: 'workflow_run' },
        { path: 'payload.action', op: 'equals', value: 'completed' },
        { path: 'payload.workflow_run.conclusion', op: 'equals', value: 'failure' },
      ],
      'payload.workflow_run.head_branch',
      'payload.workflow_run.head_commit.message',
    ),
    prompt: {
      fr: "Le workflow « {{payload.workflow_run.name}} » a échoué sur la branche {{payload.workflow_run.head_branch}} ({{payload.workflow_run.html_url}}), commit {{payload.workflow_run.head_sha}}.\n\nTrouve la cause avec `gh run view {{payload.workflow_run.id}} --log-failed`, corrige-la sur une branche dédiée et ouvre une pull request. Si l'échec ne vient pas du code (panne du service, quota), dis-le sans rien changer.",
      en: 'Workflow "{{payload.workflow_run.name}}" failed on branch {{payload.workflow_run.head_branch}} ({{payload.workflow_run.html_url}}), commit {{payload.workflow_run.head_sha}}.\n\nFind the cause with `gh run view {{payload.workflow_run.id}} --log-failed`, fix it on a dedicated branch and open a pull request. If the failure is not in the code (outage, quota), say so without changing anything.',
    },
  },
  {
    id: 'gitlab_generic',
    settings: {
      ...DEFAULT_WEBHOOK_SETTINGS,
      verification: { kind: 'token', header: 'x-gitlab-token' },
      deliveryHeader: 'x-gitlab-event-uuid',
      conditions: { mode: 'all', rules: [{ path: 'headers.x-gitlab-event', op: 'exists', value: '' }] },
    },
    prompt: {
      fr: 'Événement GitLab « {{headers.x-gitlab-event}} » reçu pour {{payload.project.path_with_namespace}} :\n\n{{payload}}',
      en: 'GitLab event "{{headers.x-gitlab-event}}" received for {{payload.project.path_with_namespace}}:\n\n{{payload}}',
    },
  },
]

/** Call summary for the journal, based on known forge headers. */
export function summarizeEvent(event: AutomationEvent): string | null {
  const kind = event.headers['x-github-event'] ?? event.headers['x-gitlab-event'] ?? event.headers['x-event-key']
  const action = readPath(event.payload, 'action')
  if (!kind) return typeof action === 'string' ? action : null
  return typeof action === 'string' ? `${kind} · ${action}` : kind
}
