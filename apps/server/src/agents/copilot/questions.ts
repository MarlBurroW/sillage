import type { AgentQuestion } from '@sillage/protocol'
import { fields } from '../acp/content.js'

/**
 * Copilot's `ask_user` reaches an ACP client as an `elicitation/create` form (probed on 1.0.116),
 * offered only to clients that announce `elicitation.form`. A form made only of choices is what
 * the other CLIs call a question, and its schema says the user may also answer freely: it becomes
 * a Sillage question. Anything else (text, numbers, booleans) stays a form.
 */

interface Choice { label: string; value: string }
interface ChoiceField { key: string; title: string | null; description: string | null; multiple: boolean; choices: Choice[] }

function text(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value : null }

function labeled(options: unknown): Choice[] | null {
  if (!Array.isArray(options) || !options.length) return null
  const choices = options.map((option) => {
    const entry = fields(option)
    return typeof entry.const === 'string' ? { value: entry.const, label: text(entry.title) ?? entry.const } : null
  })
  return choices.every((choice) => choice !== null) ? choices : null
}

function plain(values: unknown, names: unknown): Choice[] | null {
  if (!Array.isArray(values) || !values.length || !values.every((value) => typeof value === 'string')) return null
  const labels = Array.isArray(names) ? names : []
  return values.map((value, index) => ({ value, label: text(labels[index]) ?? value }))
}

function choiceField(key: string, raw: unknown): ChoiceField | null {
  const property = fields(raw)
  const base = { key, title: text(property.title), description: text(property.description) }
  if (property.type === 'string') {
    const choices = plain(property.enum, property.enumNames) ?? labeled(property.oneOf)
    return choices ? { ...base, multiple: false, choices } : null
  }
  if (property.type === 'array') {
    const items = fields(property.items)
    const choices = plain(items.enum, items.enumNames) ?? labeled(items.anyOf) ?? labeled(items.oneOf)
    return choices ? { ...base, multiple: true, choices } : null
  }
  return null
}

export interface AskUserQuestions {
  questions: AgentQuestion[]
  /** The form content Copilot expects, from the labels the user picked or typed. */
  content(answers: Record<string, string[]>): Record<string, string | string[]>
}

/** Null when the form holds anything but choices: it then goes through the elicitation form. */
export function askUserQuestions(message: string, requestedSchema: unknown): AskUserQuestions | null {
  const properties = Object.entries(fields(fields(requestedSchema).properties))
  if (!properties.length) return null
  const parsed = properties.map(([key, raw]) => choiceField(key, raw))
  if (!parsed.every((field) => field !== null)) return null
  const single = parsed.length === 1
  return {
    questions: parsed.map((field, index) => ({
      id: field.key,
      header: field.title ?? (single ? '' : field.key),
      // The message is the question itself when there is one field; otherwise it introduces the first.
      question: single ? message : [index === 0 ? message : null, field.description ?? field.title ?? field.key].filter(Boolean).join('\n\n'),
      multiSelect: field.multiple,
      allowOther: true,
      secret: false,
      options: field.choices.map((choice) => ({ label: choice.label, description: '', preview: null })),
    })),
    content(answers) {
      const content: Record<string, string | string[]> = {}
      for (const field of parsed) {
        const values = (answers[field.key] ?? []).map((answer) => field.choices.find((choice) => choice.label === answer)?.value ?? answer)
        if (!values.length) continue
        content[field.key] = field.multiple ? values : values[0]!
      }
      return content
    },
  }
}
