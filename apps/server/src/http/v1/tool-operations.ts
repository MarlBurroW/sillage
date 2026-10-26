import type { FastifyInstance, FastifyRequest } from 'fastify'
import { instructionsModeSchema, memoryModeSchema, agentKindSchema, type ApiScope } from '@sillage/protocol'
import { badRequest } from '../errors.js'

/** REST operations offered by both tool transports. Execution always uses the original route. */
interface Operation {
  name: string
  description: string
  scope?: ApiScope
  method: 'GET' | 'POST'
  route: string
  properties?: Record<string, object>
  required?: string[]
  query?: string[]
}
const string = { type: 'string' }
const task = { ...string, description: 'Task/session ID.' }
const project = { ...string, description: 'Project ID from list_task_projects.' }
const config = { type: 'object', description: 'Optional model and effort overrides; see list_agents and inspect_access. Native fields: model, effort (Claude), reasoningEffort (Codex/Grok/Antigravity), variant (OpenCode). Safeguards cannot be overridden.' }
const listQuery = { projectId: project, status: string, scope: { type: 'string', enum: ['token', 'user'], description: 'token by default; user includes your other sessions within allowed projects.' } }
export const TOOL_OPERATIONS: Operation[] = [
  { name: 'inspect_access', description: 'Inspect this key: scopes, permitted projects, CLI/model/effort restrictions and defaults. Defaults are used only when omitted; callers may choose any authorized value.', method: 'GET', route: '/api/v1/access' },
  { name: 'list_task_projects', description: 'List accessible projects, worktrees and default task configuration.', scope: 'projects:read', method: 'GET', route: '/api/v1/projects' },
  { name: 'list_agents', description: 'List authorized CLIs, models and effort levels available to this key, plus its defaults and execution policy.', scope: 'projects:read', method: 'GET', route: '/api/v1/agents' },
  { name: 'create_project', description: 'Attach an existing absolute workspacePath, or create directory under parentDir. Requires a key without project restrictions.', scope: 'projects:write', method: 'POST', route: '/api/v1/projects', properties: { name: string, workspacePath: string, parentDir: string, directory: string, visibility: { type: 'string', enum: ['private', 'shared'] }, color: { type: ['string', 'null'] }, instructionsMode: { type: 'string', enum: instructionsModeSchema.options }, memoryMode: { type: 'string', enum: memoryModeSchema.options } }, required: ['name'] },
  { name: 'create_task', description: 'Launch a session with a prompt, optional CLI, model and effort. Key defaults apply only to omitted values; its execution policy limits choices. Returns structured status and pending requests.', scope: 'tasks:write', method: 'POST', route: '/api/v1/projects/:projectId/tasks', properties: { projectId: project, prompt: string, title: string, agent: { type: 'string', enum: agentKindSchema.options }, config, model: string, effort: string, worktreeId: { type: ['string', 'null'] }, webhookUrl: string, replyDeadlineSec: { type: 'integer', minimum: 0, maximum: 86400 }, idempotencyKey: string }, required: ['projectId', 'prompt'] },
  { name: 'list_tasks', description: 'List tasks across authorized projects; optionally filter project, state and origin.', scope: 'tasks:read', method: 'GET', route: '/api/v1/tasks', properties: listQuery, query: Object.keys(listQuery) },
  { name: 'read_task', description: 'Read a task, its progress, result and pending input.', scope: 'tasks:read', method: 'GET', route: '/api/v1/tasks/:taskId', properties: { taskId: task }, required: ['taskId'] },
  { name: 'read_task_events', description: 'Read a paginated task journal. Pass nextAfter as after to continue.', scope: 'tasks:read', method: 'GET', route: '/api/v1/tasks/:taskId/events', properties: { taskId: task, after: { type: 'integer', minimum: 0 }, limit: { type: 'integer' }, types: { ...string, description: 'Comma-separated event types.' } }, required: ['taskId'], query: ['after', 'limit', 'types'] },
  { name: 'message_task', description: 'Send a prompt to resume an existing task within this key’s execution permissions.', scope: 'tasks:write', method: 'POST', route: '/api/v1/tasks/:taskId/messages', properties: { taskId: task, prompt: string }, required: ['taskId', 'prompt'] },
  { name: 'steer_task', description: 'Steer an active turn; onMissedTurn controls fallback to a queued message.', scope: 'tasks:write', method: 'POST', route: '/api/v1/tasks/:taskId/steer', properties: { taskId: task, prompt: string, onMissedTurn: { type: 'string', enum: ['queue', 'fail'] } }, required: ['taskId', 'prompt'] },
  { name: 'interrupt_task', description: 'Stop a task’s current turn, preserving its context.', scope: 'tasks:write', method: 'POST', route: '/api/v1/tasks/:taskId/interrupt', properties: { taskId: task }, required: ['taskId'] },
  { name: 'reply_task', description: 'Answer a pending request from read_task. kind: permission (decision, scope), question (answers, status), plan (decision, followUpMode), elicitation (action, content).', scope: 'tasks:write', method: 'POST', route: '/api/v1/tasks/:taskId/replies/:requestId', properties: { taskId: task, requestId: string, kind: { type: 'string', enum: ['permission', 'question', 'plan', 'elicitation'] }, decision: string, scope: string, answers: { type: 'object' }, status: string, followUpMode: { type: ['string', 'null'] }, action: string, content: { type: 'object' } }, required: ['taskId', 'requestId', 'kind'] },
]

export function operationTools(scopes: string[]) {
  return TOOL_OPERATIONS.filter((op) => !op.scope || scopes.includes(op.scope)).map((op) => ({
    name: op.name, description: op.description,
    inputSchema: { type: 'object', properties: op.properties ?? {}, required: op.required ?? [], additionalProperties: false },
  }))
}

export async function callOperation(app: FastifyInstance, request: FastifyRequest, operation: Operation, args: Record<string, unknown>) {
  const body = { ...args }
  let url = operation.route.replace(/:([A-Za-z]+)/g, (_, key: string) => {
    const value = body[key]
    if (typeof value !== 'string' || !value) throw badRequest('tool_argument_required', 'The {field} argument is required.', { field: key })
    delete body[key]
    return encodeURIComponent(value)
  })
  const query = new URLSearchParams()
  for (const key of operation.query ?? []) {
    if (body[key] !== undefined) query.set(key, String(body[key]))
    delete body[key]
  }
  if (query.size) url += `?${query}`
  const idempotencyKey = body.idempotencyKey
  delete body.idempotencyKey
  // Forward only credentials and public host information; caller-controlled paths never enter here.
  const response = await app.inject({
    method: operation.method, url,
    headers: {
      authorization: request.headers.authorization!, host: request.host,
      'x-forwarded-proto': request.protocol,
      ...(typeof idempotencyKey === 'string' ? { 'idempotency-key': idempotencyKey } : {}),
    },
    ...(operation.method === 'POST' ? { payload: body } : {}),
  })
  const data = response.json() as unknown
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: { data },
    ...(response.statusCode >= 400 ? { isError: true } : {}),
  }
}
