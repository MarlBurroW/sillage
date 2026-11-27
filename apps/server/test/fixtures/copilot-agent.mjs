#!/usr/bin/env node
// `copilot --acp` wire shapes captured from GitHub Copilot CLI 1.0.116. No network or model calls.
import { appendFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
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
writeFileSync(join(root, 'launch.json'), JSON.stringify({ args: process.argv.slice(2), instructions: process.env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS ?? null, autoUpdate: process.env.COPILOT_AUTO_UPDATE }))
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
const commands = () => update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Summarize' }, { name: 'cwd', description: 'Change directory' }, { name: 'model', description: 'Select model' }, { name: 'usage', description: 'Usage' }] })
async function prompt(id, params) {
  const text = params.prompt.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
  const scenario = text.startsWith('fixture:') ? JSON.parse(text.slice(8).split('\n')[0]) : { steps: [] }
  active = id
  for (const step of scenario.steps ?? []) {
    if (active !== id) return
    if (step.update) update(step.update)
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
    case 'initialize': return reply({ protocolVersion: 1, agentInfo: { name: 'Copilot', title: 'Copilot', version: '1.0.116' }, agentCapabilities: { loadSession: true, auth: { logout: {} }, mcpCapabilities: { http: true, sse: true }, promptCapabilities: { image: true, audio: false, embeddedContext: true }, sessionCapabilities: { close: {}, list: {} } }, authMethods: [] })
    case 'session/new':
      setTimeout(commands, 5)
      return reply({ sessionId, models: { availableModels: [], currentModelId: model }, configOptions: options() })
    case 'session/load':
      sessionId = message.params.sessionId
      // Copilot replays the stored history before answering.
      update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Earlier question' } })
      update({ sessionUpdate: 'tool_call', toolCallId: 'old', title: 'ls', kind: 'execute', status: 'pending', rawInput: { command: 'ls', description: 'List files' } })
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'old', status: 'completed', rawOutput: { content: 'a.txt' } })
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Earlier answer' } })
      commands()
      return reply({ models: { availableModels: [], currentModelId: model }, configOptions: options() })
    case 'session/set_config_option': {
      const { configId, value } = message.params
      if (configId === 'model') {
        if (!['auto', 'gpt-test'].includes(value)) return write({ id: message.id, error: { code: -32602, message: `Invalid modelId '${value}': not one of this session's models.` } })
        model = value
      } else if (configId === 'reasoning_effort') effort = value
      else if (configId === 'mode') mode = value
      else if (configId === 'allow_all') allowAll = value
      else return write({ id: message.id, error: { code: -32602, message: `Unknown config option '${configId}'.` } })
      return reply({ configOptions: options() })
    }
    case 'session/prompt': return void prompt(message.id, message.params)
    case 'session/cancel': if (active !== null) { write({ id: active, result: { stopReason: 'cancelled' } }); active = null } return
    default: return write({ id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } })
  }
})
