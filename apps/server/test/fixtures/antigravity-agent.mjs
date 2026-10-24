#!/usr/bin/env node
// ACP 1.4.3 wire shapes captured from Google's distribution. No network or model calls.
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
const root = dirname(process.argv[1])
const record = (entry) => appendFileSync(join(root, 'rpc.jsonl'), JSON.stringify(entry) + '\n')
const write = (entry) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...entry }) + '\n')
const pending = new Map()
let next = 1000
let sessionId = 'native-session'
let model = 'gemini-test'
let effort = 'high'
let mode = 'default'
let active = null
const options = () => [
  { id: 'model', category: 'model', name: 'Model', type: 'select', currentValue: model, options: [{ value: 'gemini-test', name: 'Gemini Test' }, { value: 'gemini-fast', name: 'Gemini Fast' }] },
  { id: 'thinking_level', category: 'thought_level', name: 'Thinking Level', type: 'select', currentValue: effort, options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
  { id: 'mode', category: 'mode', name: 'Mode', type: 'select', currentValue: mode, options: ['default', 'auto_edit', 'yolo'].map((value) => ({ value, name: value })) },
]
const update = (value) => write({ method: 'session/update', params: { sessionId, update: value } })
writeFileSync(join(root, 'launch.json'), JSON.stringify({ home: process.env.GEMINI_HOME, forcedFileStorage: process.env.AGY_ACP_FORCE_FILE_STORAGE, apiKey: process.env.GEMINI_API_KEY ? 'present' : 'absent' }))
async function prompt(id, params) {
  const text = params.prompt.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
  if (text === '/usage') {
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '- **Gemini Pro**\n  - **Weekly Limit Remaining:** 91% remaining (resets Oct 29, 2026)' } })
    write({ id, result: { stopReason: 'end_turn' } }); return
  }
  const scenario = text.startsWith('fixture:') ? JSON.parse(text.slice(8)) : { steps: [] }
  active = id
  for (const step of scenario.steps ?? []) {
    if (active !== id) return
    if (step.update) update(step.update)
    if (step.wait) await new Promise((resolve) => setTimeout(resolve, step.wait))
    if (step.permission) {
      const request = next++
      const answer = new Promise((resolve) => pending.set(request, resolve))
      write({ id: request, method: 'session/request_permission', params: { sessionId, ...step.permission } })
      record({ answer: await answer })
    }
  }
  if (active === id) { active = null; write({ id, result: { stopReason: 'end_turn', usage: scenario.usage ?? {} } }) }
}
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (!message.method) { pending.get(message.id)?.(message.result); pending.delete(message.id); return }
  record(message)
  const reply = (result) => write({ id: message.id, result })
  switch (message.method) {
    case 'initialize': return reply({ protocolVersion: 1, agentInfo: { name: 'antigravity-acp', version: '1.4.3' }, agentCapabilities: { loadSession: true, auth: { logout: {} }, sessionCapabilities: { list: {}, resume: {} }, promptCapabilities: { image: true, audio: true, embeddedContext: true } }, authMethods: [{ id: 'gemini-api-key', name: 'Gemini API key' }] })
    case 'authenticate':
      if (existsSync(join(root, 'reject-login'))) return write({ id: message.id, error: { code: -32000, message: `Rejected ${process.env.GEMINI_API_KEY || ''}` } })
      if (message.params.methodId.startsWith('oauth-')) {
        const callback = createServer((request, response) => {
          const url = new URL(request.url, 'http://127.0.0.1')
          if (url.searchParams.get('state') !== 'fixture-state') { response.writeHead(400); response.end(); return }
          writeFileSync(join(process.env.GEMINI_HOME, 'antigravity-acp', 'acp_token.json'), '{"testOnly":true}', { mode: 0o600 })
          response.end('Signed in')
          callback.close()
          reply({ _meta: { antigravity: { tier: { name: 'Google AI Pro' } } } })
        }).listen(0, '127.0.0.1', () => process.stderr.write('https://accounts.google.com/o/oauth2/auth?state=fixture-state&redirect_uri=' + encodeURIComponent(`http://127.0.0.1:${callback.address().port}/`) + '\n'))
        return
      }
      return reply({ _meta: { antigravity: { tier: { name: 'Google AI Pro' } } } })
    case 'logout': return reply({})
    case 'session/list': return reply({ sessions: existsSync(join(root, 'sessions.json')) ? JSON.parse(readFileSync(join(root, 'sessions.json'), 'utf8')) : [] })
    case 'session/load':
      sessionId = message.params.sessionId
      for (const entry of JSON.parse(readFileSync(join(root, 'history.json'), 'utf8'))) update(entry)
      return reply({ configOptions: options() })
    case 'session/new':
    case 'session/resume':
      sessionId = message.params.sessionId ?? randomUUID()
      // Exercise notifications arriving before session/new's response.
      update({ sessionUpdate: 'available_commands_update', availableCommands: ['plan', 'usage', 'logout'].map((name) => ({ name, description: name })) })
      return reply({ sessionId, configOptions: options() })
    case 'session/set_config_option':
      if (message.params.configId === 'model') model = message.params.value
      else if (message.params.configId === 'thinking_level') effort = message.params.value
      else if (message.params.configId === 'mode') mode = message.params.value
      else return write({ id: message.id, error: { code: -32602, message: 'Unknown native option' } })
      return reply({ configOptions: options() })
    case 'session/prompt': void prompt(message.id, message.params); return
    case 'session/cancel': {
      const id = active; active = null
      for (const resolve of pending.values()) resolve({ outcome: { outcome: 'cancelled' } })
      pending.clear()
      if (id !== null) write({ id, result: { stopReason: 'cancelled' } })
      return
    }
    // The actual distribution returns {} for an unsupported fork; it is not success.
    case 'session/fork': return reply({})
    default: return write({ id: message.id, error: { code: -32601, message: 'Unsupported method' } })
  }
})
