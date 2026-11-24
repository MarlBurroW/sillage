import type { FormAnswer, FormField, FormInfo } from '@sillage/opencode-bindings/v2'
import type { AgentQuestion, ElicitationField } from '@sillage/protocol'
import type { ElicitationDetails } from '../../interactions.js'
import type { ElicitationAnswer, QuestionAnswer } from '../../types.js'
import { fields, text } from '../tools.js'

/**
 * OpenCode 2 forms in Sillage terms.
 *
 * 2.x replaced 1.x questions with generic forms (probed 2.4.1). The question tool opens one with
 * `metadata.kind: "question"` and one field per question: a `string` with options for a single
 * choice, a `multiselect` for several, `custom` allowing free text. Other kinds (MCP elicitations,
 * authentication) carry arbitrary typed fields, which map onto Sillage's elicitation fields.
 */

type Field = FormField

function isQuestionField(field: Field): boolean {
  return field.type === 'multiselect' || (field.type === 'string' && (field.options?.length ?? 0) > 0)
}

/** Question forms Sillage renders as questions; anything else goes through elicitations. */
export function isQuestionForm(form: FormInfo): boolean {
  return fields(form.metadata).kind === 'question' && form.fields.every(isQuestionField)
}

export function formQuestions(form: FormInfo): AgentQuestion[] {
  return form.fields.map((field) => {
    const options = 'options' in field ? (field.options ?? []) : []
    return {
      id: field.key,
      header: field.title ?? '',
      question: field.description ?? field.title ?? '',
      multiSelect: field.type === 'multiselect',
      allowOther: 'custom' in field && field.custom === true,
      secret: false,
      options: options.map((option) => ({ label: option.label, description: option.description ?? '', preview: null })),
    }
  })
}

/**
 * Form answer from Sillage's, which carries option labels or free text. Labels go back to their
 * option values; free text passes as typed.
 */
export function questionAnswer(form: FormInfo, answer: QuestionAnswer): FormAnswer {
  return Object.fromEntries(form.fields.map((field) => {
    const options = 'options' in field ? (field.options ?? []) : []
    const values = (answer.answers[field.key] ?? []).map((label) => options.find((option) => option.label === label)?.value ?? label)
    return [field.key, field.type === 'multiselect' ? values : (values[0] ?? '')]
  }))
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function toElicitationField(field: Field): ElicitationField | null {
  const base = { name: field.key, label: field.title ?? field.key, description: field.description ?? null, required: 'required' in field && field.required === true }
  switch (field.type) {
    case 'string':
      if (field.options?.length) {
        return { ...base, kind: 'select', options: field.options.map(({ value, label }) => ({ value, label })), default: field.default ?? null }
      }
      return { ...base, kind: 'text', format: field.format ?? null, minLength: field.minLength ?? null, maxLength: field.maxLength ?? null, default: field.default ?? null }
    case 'number':
    case 'integer':
      return { ...base, kind: 'number', integer: field.type === 'integer', minimum: finite(field.minimum), maximum: finite(field.maximum), default: finite(field.default) }
    case 'boolean':
      return { ...base, kind: 'boolean', default: field.default ?? false }
    case 'multiselect':
      return { ...base, kind: 'multiselect', options: field.options.map(({ value, label }) => ({ value, label })), minItems: field.minItems ?? null, maxItems: field.maxItems ?? null, default: field.default ?? [] }
    default:
      return null
  }
}

/**
 * Elicitation view of a non-question form. A form whose only visible field is `external` asks to
 * open a link (an OAuth page): that is MCP's URL mode.
 */
export function formElicitation(form: FormInfo): ElicitationDetails {
  const meta = fields(form.metadata)
  const visible = form.fields.filter((field) => !('hidden' in field && field.hidden === true))
  const external = visible.find((field) => field.type === 'external')
  const serverName = text(meta.server) ?? text(meta.mcp) ?? text(meta.kind) ?? 'opencode'
  if (external && external.type === 'external' && visible.length === 1) {
    return { serverName, mode: 'url', message: external.description ?? form.title, url: external.url, fields: [], title: external.title ?? form.title }
  }
  return {
    serverName,
    mode: 'form',
    message: form.title,
    url: null,
    fields: visible.map(toElicitationField).filter((field): field is ElicitationField => field !== null),
    title: form.title,
  }
}

export function elicitationAnswer(answer: ElicitationAnswer): FormAnswer {
  return { ...answer.content }
}
