import type { CardColumn } from '@sillage/protocol'

/**
 * Correspondance entre les colonnes du board et l'état d'une issue.
 *
 * GitHub n'a que « ouverte » et « fermée » ; les colonnes intermédiaires passent par
 * deux labels choisis dans le réglage du board. Un label vide fait de la colonne une
 * étape locale : la carte y est, l'issue reste simplement ouverte.
 */

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

/** Fermée sans suite : `not_planned`, ou `duplicate` que GitHub propose aussi. */
const abandoned = (reason: string | null) => reason === 'not_planned' || reason === 'duplicate'

/** La colonne que dit l'état de l'issue. */
export function impliedColumn(remote: RemoteState, settings: ColumnLabels): CardColumn {
  if (remote.state === 'closed') return abandoned(remote.stateReason) ? 'abandoned' : 'done'
  if (hasLabel(remote.labels, settings.reviewLabel)) return 'review'
  if (hasLabel(remote.labels, settings.progressLabel)) return 'in_progress'
  return 'todo'
}

/** L'état qu'il faudrait donner à l'issue pour qu'elle dise cette colonne. */
export function desiredState(column: CardColumn, remote: RemoteState, settings: ColumnLabels): RemoteState {
  const others = remote.labels.filter((label) => !hasLabel([settings.progressLabel, settings.reviewLabel], label))
  const target = column === 'in_progress' ? settings.progressLabel : column === 'review' ? settings.reviewLabel : ''
  const labels = target ? [...others, target] : others
  if (column === 'done') return { state: 'closed', stateReason: 'completed', labels }
  if (column === 'abandoned') return { state: 'closed', stateReason: 'not_planned', labels }
  return { state: 'open', stateReason: null, labels }
}

/**
 * L'issue dit-elle déjà cette colonne ? Une issue fermée sans motif (les anciennes) vaut
 * « terminée », et les labels se comparent sans casse, comme GitHub le fait.
 */
export function columnMatches(column: CardColumn, remote: RemoteState, settings: ColumnLabels): boolean {
  const wanted = desiredState(column, remote, settings)
  if (wanted.state !== remote.state) return false
  if (remote.state === 'closed' && abandoned(remote.stateReason) !== (column === 'abandoned')) return false
  if (wanted.labels.length !== remote.labels.length) return false
  return wanted.labels.every((label) => hasLabel(remote.labels, label))
}

/** L'état d'une colonne a-t-il changé entre deux lectures de l'issue ? */
export function columnStateChanged(before: RemoteState, after: RemoteState, settings: ColumnLabels): boolean {
  return impliedColumn(before, settings) !== impliedColumn(after, settings) || before.state !== after.state
}
