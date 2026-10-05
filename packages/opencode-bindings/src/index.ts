import type { components, operations } from './openapi.js'

/**
 * Noms courts des schémas dont l'adaptateur opencode se sert.
 *
 * Écrit à la main, contrairement à `openapi.d.ts` : c'est la liste de ce que Sillage
 * tient pour acquis dans l'API. Un schéma renommé ou retiré par une nouvelle version
 * d'opencode casse la compilation ici, à un endroit qui dit pourquoi.
 *
 * Uniquement la première génération de l'API (`/session/...`, flux `GET /event`). Les
 * schémas `SessionNext*`, `PermissionV2*` et `QuestionV2*` appartiennent à la seconde,
 * que l'adaptateur ne parle pas.
 */
type Schemas = components['schemas']

export type { components, operations }

export type Event = Schemas['Event']
export type EventType = Event['type']
export type EventOf<T extends EventType> = Extract<Event, { type: T }>

export type Session = Schemas['Session']
export type SessionStatus = Schemas['SessionStatus']
export type Message = Schemas['Message']
export type UserMessage = Schemas['UserMessage']
export type AssistantMessage = Schemas['AssistantMessage']
export type Part = Schemas['Part']
export type PartOf<T extends Part['type']> = Extract<Part, { type: T }>
export type ToolPart = Schemas['ToolPart']
export type ToolState = Schemas['ToolState']
export type TextPartInput = Schemas['TextPartInput']
export type FilePartInput = Schemas['FilePartInput']
export type Todo = Schemas['Todo']

export type PermissionRequest = Schemas['PermissionRequest']
export type QuestionRequest = Schemas['QuestionRequest']
export type QuestionInfo = Schemas['QuestionInfo']

export type Config = Schemas['Config']
export type PermissionConfig = Schemas['PermissionConfig']
export type McpLocalConfig = Schemas['McpLocalConfig']
export type McpRemoteConfig = Schemas['McpRemoteConfig']
export type MCPStatus = Schemas['MCPStatus']

export type Provider = Schemas['Provider']
export type Model = Schemas['Model']
export type Agent = Schemas['Agent']
export type Command = Schemas['Command']

/** Corps JSON d'une requête, par identifiant d'opération de l'OpenAPI. */
export type RequestBody<O extends keyof operations> = operations[O] extends {
  requestBody?: { content: { 'application/json': infer B } }
}
  ? B
  : never

/** Réponse JSON 200 d'une opération. */
export type ResponseBody<O extends keyof operations> = operations[O] extends {
  responses: { 200: { content: { 'application/json': infer R } } }
}
  ? R
  : never
