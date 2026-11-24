import type { components, operations } from './openapi.js'

/**
 * Short names for the OpenCode 2 schemas the adapter relies on.
 *
 * Handwritten, unlike `openapi.d.ts`: the list of what Sillage takes for granted in the 2.x server
 * (`/api/...`, `GET /api/event`). A schema renamed or removed by a new OpenCode release breaks
 * compilation here, at a place that says why.
 */
type Schemas = components['schemas']

export type { components, operations }

/**
 * Stream events with a literal `type`. The union also holds `V2Event.rpc`, typed `type: string`,
 * which would defeat narrowing on every `switch`; such frames still arrive at runtime and land in
 * a translator's default branch.
 */
type Literal<E> = E extends { type: infer T } ? (string extends T ? never : E) : never
export type Event = Literal<Schemas['V2Event']>
export type EventType = Event['type']
export type EventOf<T extends EventType> = Extract<Event, { type: T }>
export type EventData<T extends EventType> = EventOf<T>['data']

export type SessionInfo = Schemas['Session.Info']
export type MessageInfo = Schemas['Session.Message.Info']
export type StructuredError = Schemas['Session.StructuredError']
export type TokenUsage = Schemas['TokenUsage.Info']
export type ModelRef = Schemas['Model.Ref']
export type PermissionReply = Schemas['Permission.Reply']
export type PermissionRule = Schemas['Permission.Rule']

export type FormInfo = Schemas['Form.Info_1']
export type FormField = Schemas['Form.Field_1']
export type FormAnswer = Schemas['Form.Answer']
export type FormValue = Schemas['Form.Value']

export type JobInfo = Schemas['Job.Info']
export type JobStatus = Schemas['Job.Status']

export type ModelInfo = Schemas['Model.Info']
export type AgentInfo = Schemas['Agent.Info']
export type CommandInfo = Schemas['Command.Info']
export type SkillInfo = Schemas['Skill.Info']
export type McpServer = Schemas['Mcp.Server']
export type FileAttachment = Schemas['PromptInput.FileAttachment']

/** JSON body of a request, by OpenAPI operation identifier. */
export type RequestBody<O extends keyof operations> = operations[O] extends {
  requestBody?: { content: { 'application/json': infer B } }
}
  ? B
  : never

/** JSON 200 response of an operation. */
export type ResponseBody<O extends keyof operations> = operations[O] extends {
  responses: { 200: { content: { 'application/json': infer R } } }
}
  ? R
  : never
