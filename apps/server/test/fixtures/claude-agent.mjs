import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

// Exercise the installed SDK's wire format without credentials or model requests.
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)
const trace = (message) => appendFileSync(process.env.CLAUDE_FIXTURE_TRACE, `${JSON.stringify(message)}\n`)
trace({ type: 'launch', args: process.argv.slice(2) })
let startupSent = false
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line)
  trace(message)
  if (message.type === 'control_request') {
    const invalid = message.request.subtype === 'apply_flag_settings' &&
      message.request.settings?.outputStyle === 'fixture-reject'
    // The CLI refuses ids that are not shell tasks of the session; any other id has written two lines.
    if (message.request.subtype === 'get_task_output') {
      send({ type: 'control_response', response: message.request.task_id === 'not-a-shell'
        ? { subtype: 'error', request_id: message.request_id, error: 'Not a shell task' }
        : { subtype: 'success', request_id: message.request_id,
            response: { output: 'tick 1\ntick 2\n', total_bytes: 9000, truncated: true } } })
      continue
    }
    // Like 2.1.332: initialize says whether launch servers were taken, set_permission_mode names
    // the mode in effect. Both stay absent unless a test asks, as with older CLIs.
    const extra = {}
    if (message.request.subtype === 'initialize' && process.env.CLAUDE_FIXTURE_MCP_APPLIED) {
      extra.mcp_servers_applied = process.env.CLAUDE_FIXTURE_MCP_APPLIED === 'true'
    }
    if (message.request.subtype === 'set_permission_mode' && process.env.CLAUDE_FIXTURE_EFFECTIVE_MODE) {
      extra.mode = process.env.CLAUDE_FIXTURE_EFFECTIVE_MODE
    }
    send({ type: 'control_response', response: invalid
      ? { subtype: 'error', request_id: message.request_id, error: 'Invalid flag settings' }
      : { subtype: 'success', request_id: message.request_id,
          response: { commands: [], models: [], agents: [], mcpServers: [], added: [], removed: [], errors: {}, ...extra } } })
    if (message.request.subtype === 'mcp_status' && !startupSent) {
      startupSent = true
      for (const event of JSON.parse(process.env.CLAUDE_FIXTURE_IDLE_EVENTS ?? '[]')) send(event)
    }
  } else if (message.type === 'user') {
    const scenario = JSON.parse(message.message.content.find((block) => block.type === 'text').text)
    if (scenario.events) {
      for (const event of scenario.events) send(event)
      continue
    }
    send({ type: 'control_request', request_id: 'native-permission', request: {
      subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'tool', input: { command: 'mkdir example' },
      permission_suggestions: scenario.suggestions,
      suppress_always_allow_rule: scenario.suppressAlwaysAllowRule,
      title: 'Create example directory',
    } })
  }
}
