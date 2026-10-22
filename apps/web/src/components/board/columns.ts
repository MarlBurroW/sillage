import type { CardColumn } from '@sillage/protocol'
import { translate, type MessageKey } from '../../lib/i18n'

const LABELS: Record<CardColumn, MessageKey> = {
  todo: 'board.column.todo',
  in_progress: 'board.column.inProgress',
  review: 'board.column.review',
  done: 'board.column.done',
  abandoned: 'board.column.abandoned',
}

/** Recompute at call time rather than module load so labels follow language changes. */
export function columnLabel(column: CardColumn): string {
  return translate(LABELS[column])
}

/**
 * Column tone: review is caution because human waiting blocks progress; abandoned stays neutral
 * because deliberate cancellation is not an alert.
 */
export const COLUMN_TONES: Record<CardColumn, 'neutral' | 'accent' | 'caution' | 'positive'> = {
  todo: 'neutral',
  in_progress: 'accent',
  review: 'caution',
  done: 'positive',
  abandoned: 'neutral',
}

export const COLUMN_DOTS: Record<CardColumn, string> = {
  todo: 'bg-ink-faint', in_progress: 'bg-accent', review: 'bg-caution', done: 'bg-positive', abandoned: 'bg-line-strong',
}
