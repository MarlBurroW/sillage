import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { sillageEventSchema } from '@sillage/protocol'
import { describeFastMode, describePluginErrors, translateSignal } from '../src/agents/claude/signals.js'

/** Les champs communs à tout message du SDK, que les cas ne répètent pas. */
const base = { uuid: '00000000-0000-0000-0000-000000000000', session_id: 'session' } as const

const message = (fields: Record<string, unknown>): SDKMessage =>
  ({ ...base, ...fields }) as unknown as SDKMessage

test('les signaux du CLI deviennent des avis valides, à repère stable quand ils se répètent', () => {
  const notification = translateSignal(
    message({ type: 'system', subtype: 'notification', key: 'fast_mode_credits', text: 'Fast mode disabled · usage credits exhausted', priority: 'high' }),
  )
  assert.equal(notification?.type, 'agent.notice')
  if (notification?.type !== 'agent.notice') return
  assert.equal(notification.level, 'warning')
  assert.equal(notification.id, 'notification:fast_mode_credits')
  assert.equal(notification.message, 'Fast mode disabled · usage credits exhausted')

  const retry = translateSignal(
    message({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 10, retry_delay_ms: 4200, error_status: 529, error: 'overloaded' }),
  )
  assert.equal(retry?.type, 'agent.notice')
  if (retry?.type !== 'agent.notice') return
  assert.equal(retry.id, 'api-retry')
  assert.match(retry.message, /HTTP 529/)
  assert.match(retry.message, /2\/10/)
  assert.match(retry.message, /4 s/)

  const refusal = translateSignal(
    message({ type: 'system', subtype: 'model_refusal_fallback', trigger: 'refusal', direction: 'retry', original_model: 'claude-fable-5-1', fallback_model: 'claude-opus-5', request_id: null, api_refusal_category: 'cyber', content: 'Falling back' }),
  )
  assert.equal(refusal?.type, 'agent.notice')
  if (refusal?.type !== 'agent.notice') return
  assert.equal(refusal.level, 'warning')
  assert.match(refusal.message, /claude-fable-5-1 a refusé de répondre \(cyber\) : le CLI réessaie avec claude-opus-5/)

  const denied = translateSignal(
    message({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', tool_use_id: 'toolu_1', decision_reason_type: 'classifier', decision_reason: 'destructive command', message: 'denied' }),
  )
  assert.equal(denied?.type, 'agent.notice')
  if (denied?.type !== 'agent.notice') return
  assert.equal(denied.message, 'Appel de Bash refusé automatiquement : destructive command.')

  for (const event of [notification, retry, refusal, denied]) sillageEventSchema.parse(event)
})

test('les messages informatifs de niveau info restent muets, les autres parlent', () => {
  assert.equal(
    translateSignal(message({ type: 'system', subtype: 'informational', content: 'hook ran', level: 'info' })),
    null,
  )
  const warning = translateSignal(
    message({ type: 'system', subtype: 'informational', content: 'Stop hook blocked continuation', level: 'warning', prevent_continuation: true }),
  )
  assert.equal(warning?.type, 'agent.notice')
  if (warning?.type !== 'agent.notice') return
  assert.equal(warning.level, 'warning')
  assert.deepEqual(warning.details, { preventContinuation: true })
})

test('suggestion de message et remise à zéro ont leur propre traduction', () => {
  assert.deepEqual(
    translateSignal(message({ type: 'prompt_suggestion', suggestion: 'Lance les tests' })),
    { type: 'suggestion.updated', text: 'Lance les tests' },
  )
  const reset = translateSignal(message({ type: 'conversation_reset', new_conversation_id: 'abc' }))
  assert.equal(reset?.type, 'agent.notice')
  if (reset?.type !== 'agent.notice') return
  assert.equal(reset.code, 'conversation_reset')
  assert.equal(reset.level, 'info')
})

test('ce qui n’est pas un signal reste ignoré', () => {
  assert.equal(translateSignal(message({ type: 'system', subtype: 'init', model: 'x', cwd: '/', tools: [] })), null)
  assert.equal(translateSignal(message({ type: 'system', subtype: 'hook_started', hook_id: 'h' })), null)
  assert.equal(translateSignal(message({ type: 'tool_progress', tool_use_id: 't', tool_name: 'Bash', parent_tool_use_id: null, elapsed_time_seconds: 3 })), null)
  assert.equal(translateSignal(message({ type: 'assistant', message: { content: [] }, parent_tool_use_id: null })), null)
})

test('le mode rapide ne parle qu’aux changements qui concernent la conversation', () => {
  // L'état de toutes les conversations qui ne l'ont pas demandé : rien à dire.
  assert.equal(describeFastMode('off', 'sdk_opt_in_required', false, null), null)
  assert.equal(describeFastMode('off', null, false, 'off'), null)

  const on = describeFastMode('on', null, true, null)
  assert.equal(on?.level, 'info')
  assert.equal(on?.id, 'fast-mode')

  const cooldown = describeFastMode('cooldown', null, true, 'on')
  assert.equal(cooldown?.level, 'warning')
  assert.match(cooldown?.message ?? '', /en pause/)

  const blocked = describeFastMode('off', 'extra_usage_disabled', true, null)
  assert.equal(blocked?.level, 'warning')
  assert.match(blocked?.message ?? '', /crédits d’usage/)
  assert.deepEqual(blocked?.details, { reason: 'extra_usage_disabled' })

  // Un motif que le CLI ajouterait demain s'affiche par sa clé plutôt que de disparaître.
  assert.match(describeFastMode('off', 'brand_new_reason' as never, true, null)?.message ?? '', /brand_new_reason/)

  const stopped = describeFastMode('off', 'sdk_opt_in_required', false, 'on')
  assert.equal(stopped?.message, 'Mode rapide désactivé.')

  for (const event of [on, cooldown, blocked, stopped]) sillageEventSchema.parse(event)
})

test('une remise à zéro dit ce qui l’a causée, et garde la phrase générale sans motif', () => {
  const describe = (fields: Record<string, unknown>) => {
    const event = translateSignal(message({ type: 'conversation_reset', new_conversation_id: base.uuid, ...fields }))
    return event?.type === 'agent.notice' ? event.message : null
  }
  assert.match(describe({}) ?? '', /Contexte effacé/)
  assert.match(describe({ trigger: 'clear' }) ?? '', /Contexte effacé/)
  assert.match(describe({ trigger: 'plan_mode_exit' }) ?? '', /Plan validé/)
  assert.match(describe({ trigger: 'un-motif-futur' }) ?? '', /Contexte effacé/)
})

test('les plugins refusés au chargement deviennent un seul avis, rien quand tout passe', () => {
  assert.equal(describePluginErrors(undefined), null)
  assert.equal(describePluginErrors([]), null)
  const one = describePluginErrors([{ plugin: 'sillage-lib', type: 'manifest', message: 'invalid manifest', path: '/tmp/lib' }])
  assert.equal(one?.id, 'plugin-errors')
  assert.equal(one?.level, 'warning')
  assert.match(one?.message ?? '', /sillage-lib \(\/tmp\/lib\) : invalid manifest/)
  assert.ok(sillageEventSchema.safeParse(one).success)
  const two = describePluginErrors([
    { plugin: 'a', type: 'x', message: 'boom' },
    { plugin: 'b', type: 'y', message: 'bang' },
  ])
  assert.match(two?.message ?? '', /^2 plugins non chargés/)
})
