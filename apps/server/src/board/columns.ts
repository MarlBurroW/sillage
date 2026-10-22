import type { CardColumn } from '@sillage/protocol'

/** Board column to issue-state mapping. GitHub has only open and closed; intermediate columns use two configurable labels. Empty labels make columns local-only stages: cards move there while issues remain open. */

export interface RemoteState {
  state: 'open' | 'closed'
  stateReason: string | null
  labels: string[]
}

export interface ColumnLabels {
  progressLabel: string
  reviewLabel: string
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const hasLabel = (labels: string[], label: string) => label !== '' && labels.some((entry) => same(entry, label))

/** Closed without completion: `not_planned`, or GitHub's `duplicate` reason. */
const abandoned = (reason: string | null) => reason === 'not_planned' || reason === 'duplicate'

/** Column derived from issue state. */
export function impliedColumn(remote: RemoteState, settings: ColumnLabels): CardColumn {
  if (remote.state === 'closed') return abandoned(remote.stateReason) ? 'abandoned' : 'done'
  if (hasLabel(remote.labels, settings.reviewLabel)) return 'review'
  if (hasLabel(remote.labels, settings.progressLabel)) return 'in_progress'
  return 'todo'
}

/** Issue state required to represent this column. */
export function desiredState(column: CardColumn, remote: RemoteState, settings: ColumnLabels): RemoteState {
  const others = remote.labels.filter((label) => !hasLabel([settings.progressLabel, settings.reviewLabel], label))
  const target = column === 'in_progress' ? settings.progressLabel : column === 'review' ? settings.reviewLabel : ''
  const labels = target ? [...others, target] : others
  if (column === 'done') return { state: 'closed', stateReason: 'completed', labels }
  if (column === 'abandoned') return { state: 'closed', stateReason: 'not_planned', labels }
  return { state: 'open', stateReason: null, labels }
}

/** Whether issues already represent this column. Legacy closed issues without reasons count as completed; compare labels case-insensitively like GitHub. */
export function columnMatches(column: CardColumn, remote: RemoteState, settings: ColumnLabels): boolean {
  const wanted = desiredState(column, remote, settings)
  if (wanted.state !== remote.state) return false
  if (remote.state === 'closed' && abandoned(remote.stateReason) !== (column === 'abandoned')) return false
  if (wanted.labels.length !== remote.labels.length) return false
  return wanted.labels.every((label) => hasLabel(remote.labels, label))
}

/** Whether column state changed between issue reads. */
export function columnStateChanged(before: RemoteState, after: RemoteState, settings: ColumnLabels): boolean {
  return impliedColumn(before, settings) !== impliedColumn(after, settings) || before.state !== after.state
}
