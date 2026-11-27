#!/usr/bin/env node
// `copilot --acp` as GitHub Copilot CLI 1.0.116 speaks it: wire shapes captured from the real
// binary driven by a scripted model provider. No network, no model, no sign-in.
//
// A prompt starting with `fixture:{…}` (JSON on its first line) plays its `steps` in order:
//   {update}            a `session/update`
//   {event, agentId?}   a `github.com/copilot/sessionEvent` notification: {type, data}
//   {permission}        a `session/request_permission` request; the answer is recorded
//   {elicit}            an `elicitation/create` request (`ask_user`); the answer is recorded
//   {wait}              milliseconds
// then answers with `stop` (default `end_turn`) and, as Copilot does, the tokens of the whole
// process so far, to which `usage` adds this turn's. `after` steps play once the prompt is
// answered: what Copilot does by itself when background work reports back. `attached` steps
// play after `assistant.idle` but before the answer, as for a shell started in async mode
// without `detach`; a new prompt meanwhile answers this one `cancelled` and stops them.
// Any other prompt gets a plain reply; `/compact` compacts.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'

if (process.argv.includes('--version') || process.argv[2] === 'version') {
  console.log('GitHub Copilot CLI 1.0.116.')
  process.exit(0)
}

// `copilot login --device-code` as probed on 1.0.116 without a terminal: the URL and code, then
// the login written to `$COPILOT_HOME/config.json`. `FIXTURE_LOGIN=fail` simulates a refusal,
// `FIXTURE_LOGIN_DELAY` the time the user takes to confirm.
if (process.argv[2] === 'login') {
  const home = process.env.COPILOT_HOME ?? process.cwd()
  process.stdout.write('To authenticate, visit https://github.com/login/device and enter code B2E9-F9F7\nWaiting for authorization...\n')
  process.stderr.write('Failed to open browser. Please visit https://github.com/login/device and enter the code B2E9-F9F7 manually.\n')
  setTimeout(() => {
    if (process.env.FIXTURE_LOGIN === 'fail') {
      process.stderr.write('Error: access_denied: the user cancelled the authorization\n')
      process.exit(1)
    }
    writeFileSync(join(home, 'config.json'), '// User settings belong in settings.json.\n// This file is managed automatically.\n' + JSON.stringify({ loggedInUsers: [{ host: 'https://github.com', login: 'octo-fixture', kind: 'githubDotCom' }], lastLoggedInUser: { host: 'https://github.com', login: 'octo-fixture' } }, null, 2))
    process.stdout.write('Signed in successfully as octo-fixture.\n')
    process.exit(0)
  }, Number(process.env.FIXTURE_LOGIN_DELAY ?? 50))
} else {

// Traces go next to the fixture, never into the working directory or a home.
const root = dirname(process.argv[1])
const record = (entry) => appendFileSync(join(root, 'rpc.jsonl'), JSON.stringify(entry) + '\n')
const write = (entry) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...entry }) + '\n')
const MODE = 'https://agentclientprotocol.com/protocol/session-modes#'
const pending = new Map()
let next = 1000
let sessionId = 'native-session'
let model = 'auto'
let effort = 'medium'
let mode = MODE + 'agent'
let allowAll = 'off'
let active = null
const spent = { inputTokens: 0, outputTokens: 0, totalTokens: 0, thoughtTokens: 0, cachedReadTokens: 0, cachedWriteTokens: 0 }
writeFileSync(join(root, 'launch.json'), JSON.stringify({ args: process.argv.slice(2), instructions: process.env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS ?? null, autoUpdate: process.env.COPILOT_AUTO_UPDATE, cwd: process.cwd(), home: process.env.COPILOT_HOME ?? null, tokens: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'].filter((name) => process.env[name]) }))

// One namespace for every MCP source, the later winning: the user's `mcp-config.json`, servers
// passed in the session request, then `--additional-mcp-config` files (probed on 1.0.116). The
// winners, with their source, go to `mcp.json`.
function mcpServers(requested) {
  const servers = new Map()
  const add = (source, entries) => { for (const [name, server] of entries) servers.set(name, { source, ...server }) }
  const home = process.env.COPILOT_HOME
  if (home && existsSync(join(home, 'mcp-config.json'))) add('user', Object.entries(JSON.parse(readFileSync(join(home, 'mcp-config.json'), 'utf8')).mcpServers))
  add('acp', (requested ?? []).map(({ name, ...server }) => [name, server]))
  const argv = process.argv.slice(2)
  argv.forEach((arg, index) => {
    if (arg === '--additional-mcp-config' && argv[index + 1]?.startsWith('@')) add('additional', Object.entries(JSON.parse(readFileSync(argv[index + 1].slice(1), 'utf8')).mcpServers))
  })
  writeFileSync(join(root, 'mcp.json'), JSON.stringify(Object.fromEntries(servers)))
  for (const name of servers.keys()) event('session.mcp_server_status_changed', { serverName: name, status: 'pending' })
}

// Auto is listed twice, as Copilot does; only the GPT model has efforts.
const options = () => [
  { type: 'select', id: 'mode', name: 'Mode', category: 'mode', currentValue: mode, options: ['agent', 'plan', 'autopilot'].map((name) => ({ value: MODE + name, name })) },
  { type: 'select', id: 'model', name: 'Model', category: 'model', currentValue: model, options: [
    { value: 'gpt-test', name: 'GPT Test', description: 'GPT Test', _meta: { copilotUsage: '1x' } },
    { value: 'auto', name: 'Auto', description: 'Let Copilot pick the best model', _meta: null },
    { value: 'auto', name: 'Auto', description: 'Auto', _meta: { copilotUsage: '0.9x' } },
  ] },
  ...(model === 'gpt-test' ? [{ type: 'select', id: 'reasoning_effort', name: 'Reasoning effort', category: 'thought_level', currentValue: effort, options: ['low', 'medium', 'high'].map((value) => ({ value, name: value })) }] : []),
  { type: 'select', id: 'allow_all', name: 'Permissions', category: 'permissions', currentValue: allowAll, options: ['off', 'auto', 'on'].map((value) => ({ value, name: value })) },
]
const update = (value) => write({ method: 'session/update', params: { sessionId, update: value } })
const event = (type, data = {}, agentId) => write({ method: 'github.com/copilot/sessionEvent', params: { sessionId, type, timestamp: new Date(0).toISOString(), data, ...(agentId ? { agentId } : {}) } })
const optionsChanged = () => update({ sessionUpdate: 'config_option_update', configOptions: options() })
const commands = () => update({ sessionUpdate: 'available_commands_update', availableCommands: [
  { name: 'compact', description: 'Summarize conversation history to reduce context window usage.', input: { hint: 'focus instructions' } },
  { name: 'cwd', description: 'Change working directory or show current directory' },
  { name: 'model', description: 'Select the AI model' },
  { name: 'session', description: 'View and manage sessions.' },
  { name: 'usage', description: 'Display session usage metrics and statistics' },
] })
const ask = (method, params) => {
  const request = next++
  const answer = new Promise((resolve) => pending.set(request, resolve))
  write({ id: request, method, params: { sessionId, ...params } })
  return answer
}

async function play(steps, alive = () => true) {
  for (const step of steps ?? []) {
    if (!alive()) return
    if (step.update) update(step.update)
    if (step.event) event(step.event.type, step.event.data, step.agentId)
    if (step.permission) record({ answer: await ask('session/request_permission', step.permission) })
    if (step.elicit) record({ elicited: await ask('elicitation/create', { mode: 'form', ...step.elicit }) })
    if (step.wait) await new Promise((resolve) => setTimeout(resolve, step.wait))
  }
}

async function prompt(id, params) {
  const text = params.prompt.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
  if (text === '/compact') {
    event('session.compaction_start', { trigger: 'manual', currentTokens: 900, tokenLimit: 128000 })
    event('session.compaction_complete', { success: true, outcome: 'applied', preCompactionTokens: 900, postCompactionTokens: 300 })
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Compacted conversation history and removed 9 messages and 600 tokens.' } })
    return write({ id, result: { stopReason: 'end_turn', usage: { ...spent } } })
  }
  const scripted = text.startsWith('fixture:')
  const scenario = scripted ? JSON.parse(text.slice(8).split('\n')[0]) : { steps: [{ update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Fixture reply.' }, messageId: `reply-${id}` } }], usage: { inputTokens: 100, outputTokens: 10 } }
  // Copilot cancels the pending request, without stopping the shell it waits for (1.0.117).
  if (active !== null) write({ id: active, result: { stopReason: 'cancelled', usage: { ...spent } } })
  active = id
  event('assistant.turn_start', { turnId: '0', agentMode: 'interactive' })
  await play(scenario.steps, () => active === id)
  if (active !== id) return
  if (scenario.attached) {
    event('assistant.idle', {})
    await play(scenario.attached, () => active === id)
    if (active !== id) return
  }
  active = null
  for (const [key, value] of Object.entries(scenario.usage ?? {})) spent[key] = (spent[key] ?? 0) + value
  spent.totalTokens = spent.inputTokens + spent.outputTokens
  event('assistant.idle', {})
  event('session.idle', { mode: 'interactive' })
  // A failed request is answered without usage.
  write({ id, result: scenario.failed ? { stopReason: scenario.stop ?? 'end_turn' } : { stopReason: scenario.stop ?? 'end_turn', usage: { ...spent } } })
  if (scenario.after) { await play(scenario.after); event('session.idle', { mode: 'interactive' }) }
}

const state = () => ({ models: { availableModels: [], currentModelId: model }, configOptions: options() })

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (!message.method) { pending.get(message.id)?.(message.result); pending.delete(message.id); return }
  record(message)
  const reply = (result) => write({ id: message.id, result })
  switch (message.method) {
    case 'initialize': return reply({ protocolVersion: 1, agentInfo: { name: 'Copilot', title: 'Copilot', version: '1.0.116' }, agentCapabilities: { loadSession: true, auth: { logout: {} }, mcpCapabilities: { http: true, sse: true }, promptCapabilities: { image: true, audio: false, embeddedContext: true }, sessionCapabilities: { close: {}, list: {} } }, authMethods: [] })
    case 'session/new':
      // What Copilot answers without a sign-in, and all it says.
      if (process.env.COPILOT_FIXTURE_SIGNED_OUT) return write({ id: message.id, error: { code: -32000, message: 'Authentication required' } })
      mcpServers(message.params.mcpServers)
      setTimeout(() => { commands(); commands() }, 5)
      return reply({ sessionId, ...state() })
    case 'session/list':
      // A session of another directory is listed too: the caller must not offer it.
      return reply({ sessions: [
        { sessionId: '11111111-1111-4111-8111-111111111111', cwd: process.cwd(), title: 'Fix the login form', updatedAt: '2026-11-27T10:00:00.000Z' },
        { sessionId: '22222222-2222-4222-8222-222222222222', cwd: process.cwd(), title: 'Older work', updatedAt: '2026-11-20T10:00:00.000Z' },
        { sessionId: '33333333-3333-4333-8333-333333333333', cwd: '/somewhere/else', title: 'Another project', updatedAt: '2026-11-27T11:00:00.000Z' },
      ] })
    case 'session/load': {
      sessionId = message.params.sessionId
      mcpServers(message.params.mcpServers)
      const child = { 'github.com/copilot': { agentId: 'agent-old' } }
      // Copilot replays the stored history before answering: prompts, calls and replies, a
      // sub-agent's included, but neither thoughts nor the session events.
      update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Earlier question' } })
      update({ sessionUpdate: 'tool_call', toolCallId: 'old', title: 'ls', kind: 'execute', status: 'pending', rawInput: { command: 'ls', description: 'List files' } })
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'old', status: 'completed', rawOutput: { content: 'a.txt\n<shellId: 0 completed with exit code 0>', contents: [{ type: 'shell_exit', shellId: '0', exitCode: 0 }] } })
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Earlier answer' }, messageId: 'old-1' })
      update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Second question' } })
      update({ sessionUpdate: 'tool_call', toolCallId: 'old-task', title: 'Read the note', kind: 'other', status: 'pending', rawInput: { name: 'scout', description: 'Read the note', agent_type: 'explore', mode: 'sync', prompt: 'Read it.' } })
      update({ sessionUpdate: 'tool_call', toolCallId: 'old-view', title: 'Viewing /p/note.txt', kind: 'read', status: 'pending', rawInput: { path: '/p/note.txt' }, _meta: child })
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'old-view', status: 'completed', rawOutput: { content: 'hello\n' }, _meta: child })
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'The note says hello.' }, messageId: 'old-2', _meta: child })
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'old-task', status: 'completed', rawOutput: { content: 'The note says hello.' } })
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Second answer' }, messageId: 'old-3' })
      commands()
      return reply(state())
    }
    case 'session/set_config_option': {
      const { configId, value } = message.params
      if (configId === 'model') {
        if (!['auto', 'gpt-test'].includes(value)) return write({ id: message.id, error: { code: -32602, message: `Invalid modelId '${value}': not one of this session's models.` } })
        model = value
      } else if (configId === 'reasoning_effort') effort = value
      else if (configId === 'mode') {
        // Autopilot turns allow-all on, and leaving it turns it back off.
        if (value === MODE + 'autopilot') allowAll = 'on'
        else if (mode === MODE + 'autopilot') allowAll = 'off'
        mode = value
        update({ sessionUpdate: 'current_mode_update', currentModeId: mode })
        optionsChanged()
      } else if (configId === 'allow_all') allowAll = value
      else return write({ id: message.id, error: { code: -32602, message: `Unknown config option '${configId}'.` } })
      return reply({ configOptions: options() })
    }
    case 'session/prompt': return void prompt(message.id, message.params)
    case 'session/cancel':
      if (active !== null) {
        event('session.info', { infoType: 'cancellation', message: 'Operation cancelled by user' })
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Info: Operation cancelled by user' } })
        write({ id: active, result: { stopReason: 'cancelled', usage: { ...spent } } })
        active = null
        event('session.idle', { aborted: true, mode: 'interactive' })
      }
      return
    default: return write({ id: message.id, error: { code: -32601, message: `"Method not found": ${message.method}`, data: { method: message.method } } })
  }
})
}
