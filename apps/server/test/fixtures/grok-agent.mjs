#!/usr/bin/env node
// Faux `grok agent stdio` déterministe : l'ACP de Grok Build 1.0.62, sans modèle ni réseau.
//
// Un prompt `fixture:{"steps":[…]}` joue son scénario : chaque étape est une mise à
// jour à émettre (`update`), une notification brute (`notify`), une requête vers le
// client (`permission` pour `session/request_permission`, `request` pour les autres ;
// la réponse est journalisée) ou une pause (`wait`).
// La réponse au `session/prompt` porte `stopReason` et `usage` du scénario.
import { appendFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

if (process.argv.includes('--version')) {
  console.log('grok 1.0.62 (fixture)')
  process.exit(0)
}

writeFileSync('launch.json', JSON.stringify({
  args: process.argv.slice(2),
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('GROK_'))),
  pid: process.pid,
}))

const record = (entry) => appendFileSync('rpc.jsonl', `${JSON.stringify(entry)}\n`)
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const notify = (method, params) => send({ jsonrpc: '2.0', method, params })

const MODELS = {
  currentModelId: 'grok-test',
  availableModels: [
    { modelId: 'grok-test', name: 'Grok Test', description: 'fixture', _meta: { totalContextTokens: 1000, reasoningEffort: 'high', reasoningEfforts: [
      { id: 'high', value: 'high', label: 'High', default: true }, { id: 'low', value: 'low', label: 'Low', default: false },
    ] } },
    { modelId: 'grok-fast', name: 'Grok Fast', _meta: { totalContextTokens: 2000, reasoningEfforts: [] } },
  ],
}

const configOptions = (model, effort) => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model, options: [] },
  { id: 'reasoning_effort', name: 'Reasoning Effort', category: 'thought_level', type: 'select', currentValue: effort, options: [] },
]

let sessionId = null
let model = 'grok-test'
let effort = 'high'
let nextRequest = 0
const pendingRequests = new Map()
let cancelled = null

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function play(id, scenario) {
  for (const step of scenario.steps ?? []) {
    if (cancelled) break
    if (step.wait) await sleep(step.wait)
    else if (step.update) notify('session/update', { sessionId, update: step.update, ...(step.meta ? { _meta: step.meta } : {}) })
    else if (step.notify) notify(step.notify, step.params)
    else if (step.permission || step.request) {
      const requestId = nextRequest++
      const answer = new Promise((resolve) => pendingRequests.set(requestId, resolve))
      const method = step.permission ? 'session/request_permission' : step.request.method
      send({ jsonrpc: '2.0', id: requestId, method, params: { sessionId, ...(step.permission ?? step.request.params) } })
      record({ answer: { method, result: await answer } })
    }
  }
  const stopReason = cancelled ? 'cancelled' : (scenario.stopReason ?? 'end_turn')
  cancelled = null
  send({ jsonrpc: '2.0', id, result: { stopReason, _meta: { usage: scenario.usage ?? {} } } })
}

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.method === undefined) {
    pendingRequests.get(message.id)?.(message.result ?? message.error)
    pendingRequests.delete(message.id)
    return
  }
  record({ method: message.method, params: message.params })
  const reply = (result) => send({ jsonrpc: '2.0', id: message.id, result })
  switch (message.method) {
    case 'initialize':
      return reply({
        protocolVersion: 1,
        agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: {} } },
        authMethods: [],
        _meta: { modelState: MODELS, availableCommands: [{ name: 'compact', description: 'Compact', input: null }, { name: 'goal', description: 'Goal', input: { hint: '<objective>' } }] },
      })
    case 'session/new':
    case 'session/resume':
      sessionId = message.params.sessionId ?? 'ses_fixture'
      model = message.params._meta?.modelId ?? model
      effort = message.params._meta?.reasoningEffort ?? effort
      notify('session/update', { sessionId, update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Compact' }] } })
      notify('_x.ai/mcp/server_status', { sessionId, name: 'declared', source: 'local', status: 'ready', reason: 'initialized', tools: null })
      return reply({ ...(message.method === 'session/new' ? { sessionId } : {}), models: MODELS, configOptions: configOptions(model, effort) })
    case 'session/set_config_option':
      if (message.params.configId === 'model') model = message.params.value
      if (message.params.configId === 'reasoning_effort') effort = message.params.value
      return reply({ configOptions: configOptions(model, effort) })
    case 'session/prompt': {
      const text = message.params.prompt.map((block) => block.text ?? '').join('\n')
      const marker = text.indexOf('fixture:')
      const scenario = marker >= 0 ? JSON.parse(text.slice(marker + 'fixture:'.length)) : { steps: [] }
      void play(message.id, scenario)
      return
    }
    case 'session/cancel':
      cancelled = true
      return
    case 'session/set_mode':
      notify('session/update', { sessionId, update: { sessionUpdate: 'current_mode_update', currentModeId: message.params.modeId } })
      return reply({})
    case '_x.ai/interject':
      return reply({ result: { status: 'queued' } })
    case '_x.ai/compact_conversation':
      notify('_x.ai/session_notification', { sessionId, update: { sessionUpdate: 'auto_compact_completed', tokens_before: 900, tokens_after: 300 } })
      return reply({})
    case '_x.ai/session/fork':
      return reply({ newSessionId: 'ses_forked', parentSessionId: message.params.sourceSessionId })
    default:
      if (message.id !== undefined) reply({})
  }
})
