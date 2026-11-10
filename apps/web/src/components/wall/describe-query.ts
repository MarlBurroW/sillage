import type { ProjectDto, QueryToken } from '@sillage/protocol'
import type { MessageKey } from '../../lib/i18n'
import { durationLabel, keyValues } from './query-vocabulary'

type Translate = (key: MessageKey, params?: Record<string, string | number>) => string

/**
 * One-line reading of a query, so a hand-typed filter is never ambiguous: “The 6 latest · project
 * Sillage · active in the last 30 min”.
 */
export function describeQuery(tokens: readonly QueryToken[], projects: readonly ProjectDto[], t: Translate): string {
  const parts: string[] = []
  let limit: string | null = null
  let sort: string | null = null
  const or = ` ${t('wall.describe.or')} `
  for (const token of tokens) {
    if (token.problem) continue
    if (token.key === 'limit') { limit = token.values[0]!; continue }
    if (token.key === 'sort') { sort = token.values[0]!; continue }
    let phrase: string
    if (token.key === null) phrase = t('wall.describe.text', { text: token.values[0]! })
    else if (token.key === 'active') phrase = t('wall.describe.active', { duration: durationLabel(token.values[0]!, t) })
    else {
      const options = keyValues(token.key, projects, t)
      const labels = token.values.map((value) => options.find((option) => option.value === value)?.label ?? value).join(or)
      phrase = token.key === 'project' ? t('wall.describe.project', { names: labels }) : labels
    }
    parts.push(token.negated ? t('wall.describe.not', { what: phrase }) : phrase)
  }
  if (sort && sort !== 'activity') {
    const label = keyValues('sort', projects, t).find((option) => option.value === sort)?.label ?? sort
    parts.push(t('wall.describe.sort', { order: label }))
  }
  const body = parts.length ? parts.join(' · ') : t('wall.describe.all')
  return limit ? `${t('wall.describe.limit', { count: limit })} · ${body}` : body
}
