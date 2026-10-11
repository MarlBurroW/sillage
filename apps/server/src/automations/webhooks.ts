import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { and, desc, eq, inArray, notInArray } from 'drizzle-orm'
import {
  automationDeliveries,
  automationWebhooks,
  conversations,
  type AutomationDeliveryRow,
  type AutomationWebhookRow,
  type Db,
} from '@sillage/db'
import {
  DEFAULT_WEBHOOK_SETTINGS,
  MAX_DELIVERY_BODY_BYTES,
  automationConditionsSchema,
  evaluateConditions,
  findSessionMarkers,
  markerText,
  readPath,
  summarizeEvent,
  valueText,
  webhookVerificationSchema,
  type AutomationDeliveryDetailDto,
  type AutomationDeliveryDto,
  type AutomationEvent,
  type AutomationTemplateId,
  type DeliveryReason,
  type DeliveryVerdict,
  type RuleResult,
  type WebhookAutomationDto,
  type WebhookSettings,
  type WebhookVerification,
} from '@sillage/protocol'
import { decryptValue, encryptValue, type EncryptedValue } from '../secrets/cipher.js'
import { runAutomationScript, type ScriptOutcome } from './script.js'

/**
 * Le webhook d'une automatisation : réglages, événement, vérification, décision et
 * journal. Le moteur de tirs reste celui des tâches planifiées (`TaskScheduler`) ;
 * ce module dit seulement si un appel doit en produire un, et avec quoi.
 */

/** Livraisons gardées par webhook : assez pour mettre des conditions au point. */
const DELIVERIES_KEPT = 100

/** En-têtes jamais écrits au journal : ils portent un secret ou une session. */
const SECRET_HEADERS = new Set(['authorization', 'cookie', 'proxy-authorization', 'x-gitlab-token'])

export function webhookUrl(publicUrl: string, token: string): string {
  return `${publicUrl.replace(/\/+$/, '')}/api/hooks/${token}`
}

export function readSettings(row: AutomationWebhookRow): WebhookSettings {
  return {
    verification: webhookVerificationSchema.parse(JSON.parse(row.verification)),
    deliveryHeader: row.deliveryHeader,
    conditions: automationConditionsSchema.parse(JSON.parse(row.conditions)),
    script: row.script,
    subjectPath: row.subjectPath,
    markerPaths: row.markerPaths,
    maxRunsPerHour: row.maxRunsPerHour,
  }
}

export function webhookToDto(row: AutomationWebhookRow, publicUrl: string): WebhookAutomationDto {
  return {
    ...readSettings(row),
    taskId: row.taskId,
    url: webhookUrl(publicUrl, row.token),
    trippedAt: row.trippedAt,
    template: (row.template as AutomationTemplateId | null) ?? null,
  }
}

export function loadWebhook(db: Db, taskId: string): AutomationWebhookRow | undefined {
  return db.select().from(automationWebhooks).where(eq(automationWebhooks.taskId, taskId)).get()
}

function settingsColumns(settings: WebhookSettings) {
  return {
    verification: JSON.stringify(settings.verification),
    deliveryHeader: settings.deliveryHeader,
    conditions: JSON.stringify(settings.conditions),
    script: settings.script,
    subjectPath: settings.subjectPath,
    markerPaths: settings.markerPaths,
    maxRunsPerHour: settings.maxRunsPerHour,
  }
}

/**
 * Le secret de signature est tiré ici et jamais choisi : c'est lui qu'on recopie chez
 * l'appelant, et un secret saisi à la main finit par être `secret`.
 */
export function createWebhook(
  db: Db,
  key: Buffer,
  taskId: string,
  settings: Partial<WebhookSettings>,
  template: AutomationTemplateId | null,
): AutomationWebhookRow {
  const row: AutomationWebhookRow = {
    taskId,
    token: randomBytes(24).toString('base64url'),
    secret: JSON.stringify(encryptValue(key, randomBytes(32).toString('hex'))),
    ...settingsColumns({ ...DEFAULT_WEBHOOK_SETTINGS, ...settings }),
    trippedAt: null,
    template,
  }
  db.insert(automationWebhooks).values(row).run()
  return row
}

export function updateWebhook(db: Db, row: AutomationWebhookRow, patch: Partial<WebhookSettings>): AutomationWebhookRow {
  const next = { ...row, ...settingsColumns({ ...readSettings(row), ...patch }) }
  db.update(automationWebhooks).set(next).where(eq(automationWebhooks.taskId, row.taskId)).run()
  return next
}

export function revealSecret(key: Buffer, row: AutomationWebhookRow): string {
  return decryptValue(key, JSON.parse(row.secret) as EncryptedValue)
}

/**
 * Nouveau secret, et nouvelle URL avec lui : un secret qu'on change parce qu'il a fuité
 * a souvent fuité avec l'adresse.
 */
export function rotateWebhook(db: Db, key: Buffer, row: AutomationWebhookRow): AutomationWebhookRow {
  const next = {
    ...row,
    token: randomBytes(24).toString('base64url'),
    secret: JSON.stringify(encryptValue(key, randomBytes(32).toString('hex'))),
  }
  db.update(automationWebhooks).set(next).where(eq(automationWebhooks.taskId, row.taskId)).run()
  return next
}

// --- Événement -----------------------------------------------------------------------

export function normalizeHeaders(raw: Record<string, string | string[] | undefined>): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue
    headers[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value
  }
  return headers
}

/**
 * Le corps lu comme JSON quand il en est : directement, ou dans le champ `payload` d'un
 * formulaire, que GitHub envoie quand le webhook est réglé en `x-www-form-urlencoded`.
 */
function parsePayload(body: string, contentType: string): unknown {
  const trimmed = body.trim()
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const field = new URLSearchParams(body).get('payload')
    if (field) {
      try { return JSON.parse(field) } catch { /* Un formulaire sans JSON reste du texte. */ }
    }
    return Object.fromEntries(new URLSearchParams(body))
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { return JSON.parse(trimmed) } catch { /* Pas du JSON : le corps brut suffira. */ }
  }
  return null
}

export function buildEvent(
  headers: Record<string, string>,
  query: Record<string, string>,
  body: string,
): AutomationEvent {
  return { headers, query, body, payload: parsePayload(body, headers['content-type'] ?? '') }
}

/** Ce qui est écrit au journal : sans en-têtes secrets, corps borné. */
function storedEvent(event: AutomationEvent, verification: WebhookVerification) {
  const headers = Object.fromEntries(
    Object.entries(event.headers).filter(([name]) =>
      !SECRET_HEADERS.has(name) && !(verification.kind !== 'none' && name === verification.header),
    ),
  )
  const bytes = Buffer.byteLength(event.body)
  const truncated = bytes > MAX_DELIVERY_BODY_BYTES
  const body = truncated ? Buffer.from(event.body).subarray(0, MAX_DELIVERY_BODY_BYTES).toString('utf8') : event.body
  return { headers, body, bytes, truncated }
}

export function eventOf(row: AutomationDeliveryRow): AutomationEvent {
  const headers = JSON.parse(row.headers) as Record<string, string>
  return buildEvent(headers, JSON.parse(row.query) as Record<string, string>, row.body)
}

// --- Vérification --------------------------------------------------------------------

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** Vérifiée sur le corps brut, octet pour octet : un JSON réécrit ne signerait plus rien. */
export function verifyCaller(
  verification: WebhookVerification,
  secret: string,
  headers: Record<string, string>,
  raw: Buffer,
): boolean {
  if (verification.kind === 'none') return true
  const received = headers[verification.header] ?? ''
  if (!received) return false
  if (verification.kind === 'token') return sameText(received, secret)
  const digest = createHmac(verification.algorithm, secret).update(raw).digest('hex')
  return sameText(received.trim().toLowerCase(), `${verification.prefix}${digest}`.toLowerCase())
}

// --- Décision ------------------------------------------------------------------------

export interface Decision {
  verdict: 'launch' | 'filtered' | 'script_skipped' | 'script_error'
  conditions: RuleResult[]
  script: ScriptOutcome | null
  subject: string | null
  vars: Record<string, unknown>
  reason: DeliveryReason | null
  /** Session dont la marque figure dans l'appel, si elle existe encore. */
  originConversationId: string | null
}

/** La première règle qui fait échouer l'appel, avec ce que son champ valait. */
function filterReason(settings: WebhookSettings, results: RuleResult[]): DeliveryReason {
  if (settings.conditions.mode === 'any') return { code: 'filter_any' }
  const index = results.findIndex((result) => !result.ok)
  const rule = settings.conditions.rules[index]!
  const actual = valueText(results[index]!.actual)
  return {
    code: 'filter_rule',
    params: { index: index + 1, path: rule.path, actual: actual.length > 80 ? `${actual.slice(0, 80)}…` : actual },
  }
}

export async function decide(db: Db, settings: WebhookSettings, event: AutomationEvent): Promise<Decision> {
  const { ok, results } = evaluateConditions(settings.conditions, event)
  const origin = findSessionMarkers(markerText(event, settings.markerPaths))
  const known = origin.length > 0
    ? db.select({ id: conversations.id }).from(conversations).where(inArray(conversations.id, origin)).all()
    : []
  const originConversationId = origin.find((id) => known.some((row) => row.id === id)) ?? null
  const base = { conditions: results, originConversationId }

  if (!ok) {
    return { ...base, verdict: 'filtered', script: null, subject: null, vars: {}, reason: filterReason(settings, results) }
  }

  const pathSubject = settings.subjectPath ? valueText(readPath(event, settings.subjectPath)) || null : null
  if (!settings.script.trim()) {
    return { ...base, verdict: 'launch', script: null, subject: pathSubject, vars: {}, reason: null }
  }

  const script = await runAutomationScript(settings.script, event)
  if (script.error) {
    return { ...base, verdict: 'script_error', script, subject: null, vars: {}, reason: script.error }
  }
  if (script.decision.kind === 'skip') {
    return {
      ...base,
      verdict: 'script_skipped',
      script,
      subject: null,
      vars: {},
      reason: { code: 'script_skip', params: script.decision.reason ? { reason: script.decision.reason } : {} },
    }
  }
  return {
    ...base,
    verdict: 'launch',
    script,
    subject: script.decision.subject ?? pathSubject,
    vars: script.decision.vars,
    reason: null,
  }
}

// --- Journal -------------------------------------------------------------------------

export function recordDelivery(
  db: Db,
  input: {
    taskId: string
    event: AutomationEvent
    verification: WebhookVerification
    deliveryId: string | null
    verdict: DeliveryVerdict
    reason: DeliveryReason | null
    subject?: string | null
    vars?: Record<string, unknown>
    originConversationId?: string | null
  },
): AutomationDeliveryRow {
  const stored = storedEvent(input.event, input.verification)
  const row: AutomationDeliveryRow = {
    id: randomUUID(),
    taskId: input.taskId,
    receivedAt: Date.now(),
    deliveryId: input.deliveryId,
    headers: JSON.stringify(stored.headers),
    query: JSON.stringify(input.event.query),
    body: stored.body,
    bytes: stored.bytes,
    truncated: stored.truncated,
    verdict: input.verdict,
    reason: input.reason ? JSON.stringify(input.reason) : null,
    subject: input.subject ?? null,
    vars: input.vars && Object.keys(input.vars).length > 0 ? JSON.stringify(input.vars) : null,
    summary: summarizeEvent(input.event),
    runId: null,
    conversationId: null,
    originConversationId: input.originConversationId ?? null,
  }
  db.insert(automationDeliveries).values(row).run()
  prune(db, input.taskId)
  return row
}

/** Les plus anciennes partent, sauf celles qui attendent encore leur tour. */
function prune(db: Db, taskId: string): void {
  const keep = db
    .select({ id: automationDeliveries.id })
    .from(automationDeliveries)
    .where(eq(automationDeliveries.taskId, taskId))
    .orderBy(desc(automationDeliveries.receivedAt))
    .limit(DELIVERIES_KEPT)
    .all()
    .map((row) => row.id)
  if (keep.length < DELIVERIES_KEPT) return
  db.delete(automationDeliveries)
    .where(and(
      eq(automationDeliveries.taskId, taskId),
      notInArray(automationDeliveries.id, keep),
      notInArray(automationDeliveries.verdict, ['queued']),
    ))
    .run()
}

export function setDeliveryOutcome(
  db: Db,
  id: string,
  outcome: Partial<Pick<AutomationDeliveryRow, 'verdict' | 'runId' | 'conversationId'>> & { reason?: DeliveryReason | null },
): void {
  const { reason, ...rest } = outcome
  db.update(automationDeliveries)
    .set(reason === undefined ? rest : { ...rest, reason: reason ? JSON.stringify(reason) : null })
    .where(eq(automationDeliveries.id, id))
    .run()
}

/** Une raison lue en base ; un texte d'une version antérieure reste lisible tel quel. */
function readReason(raw: string | null): DeliveryReason | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as DeliveryReason
    if (parsed && typeof parsed === 'object' && typeof parsed.code === 'string') return parsed
  } catch { /* Texte libre. */ }
  return { code: 'text', params: { text: raw } }
}

export function deliveryToDto(row: AutomationDeliveryRow): AutomationDeliveryDto {
  return {
    id: row.id,
    taskId: row.taskId,
    receivedAt: row.receivedAt,
    deliveryId: row.deliveryId,
    verdict: row.verdict as DeliveryVerdict,
    reason: readReason(row.reason),
    subject: row.subject,
    conversationId: row.conversationId,
    originConversationId: row.originConversationId,
    summary: row.summary,
    bytes: row.bytes,
    truncated: row.truncated,
  }
}

export function deliveryDetailToDto(row: AutomationDeliveryRow): AutomationDeliveryDetailDto {
  return { ...deliveryToDto(row), event: eventOf(row) }
}
