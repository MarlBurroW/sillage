import type { CardColumn } from '@sillage/protocol'
import { translate, type MessageKey } from '../../lib/i18n'

const LABELS: Record<CardColumn, MessageKey> = {
  todo: 'board.column.todo',
  in_progress: 'board.column.inProgress',
  review: 'board.column.review',
  done: 'board.column.done',
  abandoned: 'board.column.abandoned',
}

/**
 * Recalculé à l'appel plutôt que figé au chargement du module : une constante
 * composée une fois resterait dans la langue de départ après un changement.
 */
export function columnLabel(column: CardColumn): string {
  return translate(LABELS[column])
}
