import { agentKindSchema, projectHandle, SESSION_QUERY_KEYS, SESSION_QUERY_VALUES, type ProjectDto, type QueryProblem, type SessionQueryKey } from '@sillage/protocol'
import { AGENT_LABELS } from '../AgentIcon'
import type { MessageKey } from '../../lib/i18n'

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string

export const KEY_HELP: Record<SessionQueryKey, MessageKey> = {
  is: 'wall.key.is', project: 'wall.key.project', cli: 'wall.key.cli', worktree: 'wall.key.worktree',
  active: 'wall.key.active', sort: 'wall.key.sort', limit: 'wall.key.limit',
}

const IS_LABELS: Record<(typeof SESSION_QUERY_VALUES.is)[number], MessageKey> = {
  running: 'wall.is.running', attention: 'wall.is.attention', idle: 'wall.is.idle', unread: 'wall.is.unread', favorite: 'wall.is.favorite',
}
const SORT_LABELS: Record<(typeof SESSION_QUERY_VALUES.sort)[number], MessageKey> = {
  activity: 'wall.sort.activity', created: 'wall.sort.created', title: 'wall.sort.title',
}

export const PROBLEM_LABELS: Record<QueryProblem, MessageKey> = {
  unknown_key: 'wall.problem.unknownKey', invalid_value: 'wall.problem.invalidValue', not_negatable: 'wall.problem.notNegatable',
}

export interface QueryValue { value: string; label: string }

/** Values offered for a key, with labels in the interface language. */
export function keyValues(key: SessionQueryKey, projects: readonly ProjectDto[], t: Translate): QueryValue[] {
  switch (key) {
    case 'is': return SESSION_QUERY_VALUES.is.map((value) => ({ value, label: t(IS_LABELS[value]) }))
    case 'project': return projects.map((project) => ({ value: projectHandle(project.name), label: project.name }))
    case 'cli': return agentKindSchema.options.map((value) => ({ value, label: AGENT_LABELS[value] }))
    case 'worktree': return SESSION_QUERY_VALUES.worktree.map((value) => ({
      value,
      label: value === 'any' ? t('wall.worktree.any') : value === 'none' ? t('wall.worktree.none') : t(`worktrees.state.${value}`),
    }))
    case 'active': return SESSION_QUERY_VALUES.active.map((value) => ({ value, label: durationLabel(value, t) }))
    case 'sort': return SESSION_QUERY_VALUES.sort.map((value) => ({ value, label: t(SORT_LABELS[value]) }))
    case 'limit': return SESSION_QUERY_VALUES.limit.map((value) => ({ value, label: value }))
  }
}

export function durationLabel(value: string, t: Translate): string {
  const match = /^(\d+)([mhd])$/.exec(value)
  if (!match) return value
  const amount = Number(match[1])
  return t(match[2] === 'm' ? 'wall.duration.minutes' : match[2] === 'h' ? 'wall.duration.hours' : 'wall.duration.days', { count: amount })
}

export interface Suggestion {
  /** Text replacing the fragment under the caret. */
  insert: string
  label: string
  /** Characters of `label` already typed, shown in bold. */
  matched: number
  hint: string
}

/** Completions for the token under the caret: keys first, then the chosen key's values. */
export function suggest(query: string, caret: number, projects: readonly ProjectDto[], t: Translate): Suggestion[] {
  const fragment = /(\S*)$/.exec(query.slice(0, caret))?.[1] ?? ''
  const dash = fragment.startsWith('-') ? '-' : ''
  const body = fragment.slice(dash.length)
  const colon = body.indexOf(':')
  if (colon < 0) {
    const typed = body.toLowerCase()
    return SESSION_QUERY_KEYS.filter((key) => key.startsWith(typed))
      .map((key) => ({ insert: `${dash}${key}:`, label: `${key}:`, matched: typed.length, hint: t(KEY_HELP[key]) }))
  }
  const key = body.slice(0, colon).toLowerCase() as SessionQueryKey
  if (!SESSION_QUERY_KEYS.includes(key)) return []
  const value = body.slice(colon + 1).replace(/^"/, '')
  const head = value.includes(',') ? value.slice(0, value.lastIndexOf(',') + 1) : ''
  const tail = value.slice(head.length).toLowerCase()
  const chosen = head.split(',').filter(Boolean)
  return keyValues(key, projects, t)
    .filter((entry) => entry.value.startsWith(tail) && !chosen.includes(entry.value))
    .map((entry) => {
      const label = `${key}:${head}${entry.value}`
      return { insert: `${dash}${label} `, label, matched: key.length + 1 + head.length + tail.length, hint: entry.label }
    })
}
