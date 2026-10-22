#!/usr/bin/env node
// Deterministic fake `grok agent stdio`: Grok Build 1.0.62 ACP without models or networking.
//
// Prompts `fixture:{"steps":[…]}` play scenarios: each step emits
// an update (`update`), raw notification (`notify`), client request
// (`permission` for `session/request_permission`, `request` otherwise, with
// journaled responses), or pause (`wait`).
// `session/prompt` responses carry scenario `stopReason` and `usage`.
import { appendFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

if (process.argv.includes('--version')) {
  console.log('grok 1.0.62 (fixture)')
  process.exit(0)
}

// `grok login --device-auth` and `grok logout` as probed on 1.0.62: URL and code,
// then authentication written to `$GROK_HOME/auth.json`. `FIXTURE_LOGIN=fail` simulates
// rejections; `FIXTURE_LOGIN_DELAY` simulates user confirmation delays.
const grokHome = process.env.GROK_HOME ?? process.cwd()
if (process.argv[2] === 'login') {
  process.stdout.write('To sign in, open this URL in your browser:\n\n  \x1b[1mhttps://accounts.x.ai/oauth2/device?user_code=W68V-VRXD\x1b[0m\n\n')
  process.stdout.write('Confirm this code in your browser:\n\n  W68V-VRXD\n\nWaiting for authorization...\n')
  setTimeout(() => {
    if (process.env.FIXTURE_LOGIN === 'fail') {
      process.stderr.write('Error: authorization denied\n')
      process.exit(1)
    }
    writeFileSync(`${grokHome}/auth.json`, '{"fixture":true}')
    process.stdout.write('\x1b[K\u2713 Signed in as fixture@example.com\n')
    process.exit(0)
  }, Number(process.env.FIXTURE_LOGIN_DELAY ?? 50))
} else if (process.argv[2] === 'logout') {
  appendFileSync(`${grokHome}/logout.log`, 'logout\n')
  process.exit(0)
}

// Beside scripts rather than cwd: catalogs launch CLIs from HOME,
// where these traces do not belong.
const here = dirname(process.argv[1])
writeFileSync(join(here, 'launch.json'), JSON.stringify({
  args: process.argv.slice(2),
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('GROK_'))),
  pid: process.pid,
}))

const record = (entry) => appendFileSync(join(here, 'rpc.jsonl'), `${JSON.stringify(entry)}\n`)
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
    case 'authenticate':
      if (message.params.methodId === 'xai.api_key' && process.env.XAI_API_KEY) {
        writeFileSync(`${grokHome}/auth.json`, JSON.stringify({ apiKey: '***' }))
        return reply({})
      }
      return send({ jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Authentication required' } })
    case '_x.ai/billing':
      return reply({
        config: { creditUsagePercent: 8, currentPeriod: { type: 'USAGE_PERIOD_TYPE_WEEKLY', start: '2026-10-12T22:23:39Z', end: '2026-10-19T22:23:39Z' },
          onDemandCap: { val: 2000 }, onDemandUsed: { val: 500 }, prepaidBalance: {} },
        subscription_tier: 'X Premium',
      })
    case '_x.ai/session/fork':
      return reply({ newSessionId: 'ses_forked', parentSessionId: message.params.sourceSessionId })
    default:
      if (message.id !== undefined) reply({})
  }
})
