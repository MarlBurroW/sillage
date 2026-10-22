import type { DecisionDto, DecisionSourceKind } from '@sillage/protocol'
import type { translate } from '../../lib/i18n'

/**
 * Decision wording in reader language. Preserve agent-written requests. Sillage cleanup proposals
 * store choice keys (clean, keep) and branch because servers lack reader locale; translate them
 * here.
 */
type Source = { source: Pick<DecisionDto['source'], 'kind' | 'label' | 'worktreePath'> }

export function decisionQuestion(decision: Source & Pick<DecisionDto, 'question'>, t: typeof translate): string {
  return decision.source.kind === 'worktree' ? t('decision.worktree.question', { branch: decision.source.label }) : decision.question
}

export function decisionContext(decision: Source & Pick<DecisionDto, 'context'>, t: typeof translate): string {
  return decision.source.kind === 'worktree'
    ? t('decision.worktree.context', { path: decision.source.worktreePath ?? '' })
    : decision.context
}

export function decisionOption(decision: Source, option: string, t: typeof translate): string {
  if (decision.source.kind !== 'worktree') return option
  if (option === 'clean') return t('decision.worktree.option.clean')
  if (option === 'keep') return t('decision.worktree.option.keep')
  return option
}

/** Toasts carry only question, source, and name, enough to reconstruct text. */
export function toastQuestion(
  notification: { question: string; sourceLabel: string; sourceKind?: DecisionSourceKind },
  t: typeof translate,
): string {
  return notification.sourceKind === 'worktree'
    ? t('decision.worktree.question', { branch: notification.sourceLabel })
    : notification.question
}
