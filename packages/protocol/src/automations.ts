import { z } from 'zod'

/**
 * Automatisations déclenchées par un webhook : un appel HTTP reçu ouvre une session
 * neuve, comme le tir d'une tâche planifiée dont elles partagent le moteur.
 *
 * Le moteur ne connaît aucun service : il reçoit des en-têtes et un corps, les passe à
 * des conditions et à un script facultatif, puis rend un prompt. GitHub et GitLab ne
 * sont que des réglages préremplis (`AUTOMATION_TEMPLATES`).
 *
 * La lecture des chemins, les conditions et le rendu du prompt vivent ici et non dans
 * le serveur : l'interface les évalue en direct sur un appel reçu, et un verdict
 * affiché qui différerait du verdict appliqué rendrait le testeur inutile.
 */

export const MAX_AUTOMATION_RULES = 30
export const MAX_AUTOMATION_SCRIPT_CHARS = 20000
export const MAX_AUTOMATION_PATH_CHARS = 300
export const MAX_AUTOMATION_VALUE_CHARS = 1000
/** Au-delà, un déclencheur qui s'emballe se met en pause tout seul. */
export const DEFAULT_AUTOMATION_RUNS_PER_HOUR = 10
export const MAX_AUTOMATION_RUNS_PER_HOUR = 120
/** Plus gros corps conservé dans le journal ; un appel plus lourd est accepté mais tronqué. */
export const MAX_DELIVERY_BODY_BYTES = 256 * 1024

// --- Chemins et gabarits -------------------------------------------------------------

/**
 * Valeur au bout d'un chemin pointé : `payload.issue.title`, `payload.commits.0.id`,
 * `headers.x-github-event`. Un segment `*` parcourt un tableau ou les valeurs d'un objet
 * et rend la liste de ce qu'il trouve : `payload.issue.labels.*.name` donne les noms de
 * tous les labels, ce qu'aucun index fixe ne saurait dire.
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

/** Texte d'une valeur pour un prompt ou une comparaison : un objet se lit en JSON. */
export function valueText(value: unknown, pretty = false): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value, null, pretty ? 2 : undefined) ?? ''
}

/** Au-delà, un `{{payload}}` entier chasserait la consigne du contexte de l'agent. */
const MAX_RENDERED_VALUE_CHARS = 20000

const PLACEHOLDER = /\{\{\s*([\w.*-]+)\s*\}\}/g

/**
 * Remplace les `{{chemin}}` d'un gabarit par leur valeur dans `scope`. Un chemin absent
 * rend une chaîne vide, sauf avec `keepMissing`, qui laisse le marqueur en place : c'est
 * ce que l'aperçu montre, pour qu'une faute de frappe se voie au lieu de disparaître.
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

/** Les chemins qu'un gabarit cite, pour signaler ceux que l'appel d'exemple n'a pas. */
export function templatePaths(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((match) => match[1]!)
}

// --- Événement ------------------------------------------------------------------------

/**
 * Ce que conditions, script et prompt voient d'un appel. Les en-têtes sont en
 * minuscules, comme HTTP les traite ; `payload` vaut null quand le corps n'est pas du
 * JSON, et `body` garde alors le texte brut.
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

/** Les opérateurs qui ne lisent pas de valeur, pour que le formulaire masque le champ. */
export const VALUELESS_OPERATORS: readonly AutomationOperator[] = ['exists', 'missing']

export interface RuleResult {
  ok: boolean
  /** Ce que le chemin a donné, pour l'afficher à côté du ✓ ou du ✗. */
  actual: unknown
  /** Une regex invalide : la règle échoue, et le formulaire dit pourquoi. */
  error?: string
}

/**
 * Une règle sur une liste (chemin avec `*`) réussit si l'un des éléments la satisfait,
 * sauf pour les négations, qui exigent qu'aucun ne corresponde : « le label n'est pas
 * `wip` » doit être faux dès qu'un des labels l'est.
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
  // `in` : une valeur par ligne ou séparée par des virgules.
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

// --- Vérification de l'appelant ------------------------------------------------------

const headerName = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9-]{1,100}$/, { message: 'An HTTP header name.' })

/**
 * Comment s'assurer qu'un appel vient bien du service attendu. L'URL est déjà secrète,
 * mais elle traîne dans les journaux d'un proxy ou d'une CI : la signature est ce qui
 * empêche qu'elle suffise à lancer des agents.
 */
export const webhookVerificationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  /** Le secret tel quel dans un en-tête (GitLab : `x-gitlab-token`). */
  z.object({ kind: z.literal('token'), header: headerName }),
  /** HMAC du corps brut (GitHub : `x-hub-signature-256`, `sha256=`). */
  z.object({
    kind: z.literal('hmac'),
    header: headerName,
    algorithm: z.enum(['sha256', 'sha1']),
    prefix: z.string().max(20),
  }),
])
export type WebhookVerification = z.infer<typeof webhookVerificationSchema>

// --- Configuration d'un webhook ------------------------------------------------------

export const webhookSettingsSchema = z.object({
  verification: webhookVerificationSchema,
  /** En-tête qui identifie une livraison, pour ignorer les rejeux ; vide pour aucun. */
  deliveryHeader: z.union([headerName, z.literal('')]),
  conditions: automationConditionsSchema,
  script: z.string().max(MAX_AUTOMATION_SCRIPT_CHARS),
  /**
   * Chemin qui nomme le sujet d'un appel (une issue, une PR, une branche) : deux appels
   * en attente sur le même sujet fusionnent, le plus récent l'emporte.
   */
  subjectPath: z.string().trim().max(MAX_AUTOMATION_PATH_CHARS),
  /**
   * Où chercher la marque d'une session Sillage, séparés par des virgules ; `*` pour
   * tout le corps, vide pour ne pas la chercher. Une marque trouvée fait compter le
   * lancement comme fait par cette session, avec ses limites de chaîne.
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

// --- Journal des livraisons ----------------------------------------------------------

/**
 * Le sort d'un appel reçu. Chaque refus a le sien : un déclencheur qui ne part jamais
 * doit dire si c'est sa signature, ses conditions ou son disjoncteur qui l'arrête.
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
 * Pourquoi un appel n'a pas lancé de session, en code et paramètres : le serveur ne
 * connaît pas la langue de l'utilisateur, c'est l'interface qui en fait une phrase.
 * `text` garde un message libre, celui d'un script (`{ skip: '…' }`) ou d'une erreur.
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
  /** L'identifiant donné par l'appelant (`x-github-delivery`), s'il en donne un. */
  deliveryId: string | null
  verdict: DeliveryVerdict
  reason: DeliveryReason | null
  subject: string | null
  conversationId: string | null
  /** Session dont la marque a été trouvée dans l'appel. */
  originConversationId: string | null
  /** Résumé lisible : l'événement GitHub et son action, quand ils existent. */
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
  /** Le disjoncteur a sauté : la tâche est en pause jusqu'à sa réactivation. */
  trippedAt: number | null
  /** Modèle d'origine, pour l'aide affichée ; null pour un webhook générique. */
  template: AutomationTemplateId | null
}

/** Ce que le script rend, une fois validé. */
export const scriptDecisionSchema = z.union([
  z.null(),
  z.literal(false),
  z.object({ skip: z.string().max(500) }),
  z.object({
    subject: z.union([z.string(), z.number()]).optional(),
    vars: z.record(z.string(), z.unknown()).optional(),
  }),
])

/** Un appel saisi sur la page : en-têtes et corps brut, comme ils arriveraient. */
export const webhookCallSchema = z.object({
  headers: z.record(z.string(), z.string()).default({}),
  body: z.string().max(MAX_DELIVERY_BODY_BYTES),
})
export type WebhookCall = z.infer<typeof webhookCallSchema>

/**
 * Essai d'une configuration, sans rien lancer ni rien écrire : sur un appel du journal
 * (`deliveryId`) ou sur un appel saisi dans le banc d'essai (`call`).
 */
export const testWebhookBodySchema = z
  .object({
    deliveryId: z.string().min(1).optional(),
    call: webhookCallSchema.optional(),
    /** Réglages en cours d'édition, pas encore enregistrés. */
    settings: webhookSettingsSchema.partial().optional(),
    prompt: z.string().max(20000).optional(),
  })
  .refine((body) => Boolean(body.deliveryId) !== Boolean(body.call), { message: 'Give either deliveryId or call.' })

/** Rejouer un appel du journal pour de vrai. */
export const replayWebhookBodySchema = z.object({ deliveryId: z.string().min(1) })

export interface WebhookTestResult {
  verdict: 'launch' | 'filtered' | 'script_skipped' | 'script_error'
  conditions: RuleResult[]
  script: { ran: boolean; error: DeliveryReason | null; result: unknown; durationMs: number; logs: string[] }
  subject: string | null
  vars: Record<string, unknown>
  /** Le prompt de l'automatisation rendu avec cet appel ; un champ absent garde son `{{…}}`. */
  prompt: string
  /** Le premier message complet que la session recevrait, en-tête de Sillage compris. */
  message: string
  reason: DeliveryReason | null
  originConversationId: string | null
}

/** La commande curl qui enverrait un appel pour de vrai. */
export const webhookCurlBodySchema = webhookCallSchema.extend({
  /** Origine de la page, pour une adresse complète quand `publicUrl` n'est pas réglée. */
  origin: z.string().max(300).optional(),
})

// --- Marque de session ----------------------------------------------------------------

/**
 * Ce que les agents laissent dans ce qu'ils écrivent sur une forge : un commentaire
 * HTML invisible dans une issue ou une PR, un trailer dans un message de commit.
 */
export function sessionMarker(conversationId: string): string {
  return `<!-- sillage:session=${conversationId} -->`
}
export function sessionTrailer(conversationId: string): string {
  return `Sillage-Session: ${conversationId}`
}

const MARKER = /(?:<!--\s*sillage:session=|Sillage-Session:\s*)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi

/** Les sessions dont un texte porte la marque, dans l'ordre où elles apparaissent. */
export function findSessionMarkers(text: string): string[] {
  return [...new Set([...text.matchAll(MARKER)].map((match) => match[1]!.toLowerCase()))]
}

/** Le texte où chercher la marque, selon `markerPaths`. */
export function markerText(event: AutomationEvent, markerPaths: string): string {
  const paths = markerPaths.split(',').map((path) => path.trim()).filter(Boolean)
  if (paths.includes('*')) return event.body
  return paths.map((path) => valueText(readPath(event, path))).join('\n')
}

// --- Modèles --------------------------------------------------------------------------

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
  /** Prompt prérempli, en français et en anglais : l'agent lit ce que l'utilisateur écrit. */
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
 * Les modèles prêts à l'emploi. Les deux premiers partent d'un geste humain (un label,
 * une commande), le schéma le plus sûr contre les chaînes : on demande aux agents de
 * ne jamais poser ce label ni écrire cette commande.
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
      // Le label est posé par une personne : la marque de l'agent qui a écrit l'issue
      // ne dit rien de qui déclenche.
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

/** Résumé d'un appel pour le journal, à partir des en-têtes des forges connues. */
export function summarizeEvent(event: AutomationEvent): string | null {
  const kind = event.headers['x-github-event'] ?? event.headers['x-gitlab-event'] ?? event.headers['x-event-key']
  const action = readPath(event.payload, 'action')
  if (!kind) return typeof action === 'string' ? action : null
  return typeof action === 'string' ? `${kind} · ${action}` : kind
}
