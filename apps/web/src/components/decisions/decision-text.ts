import type { DecisionDto, DecisionSourceKind } from '@sillage/protocol'
import type { translate } from '../../lib/i18n'

/**
 * Les mots d'une décision, dans la langue du lecteur.
 *
 * Une demande d'agent s'affiche telle qu'il l'a écrite. Une proposition de nettoyage
 * d'arbre vient de Sillage, qui ne connaît pas la langue du lecteur : le serveur garde
 * des clés de choix (`clean`, `keep`) et la branche, et c'est ici qu'on les rédige.
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

/** Le toast n'a que la question, la source et son nom : assez pour la recomposer. */
export function toastQuestion(
  notification: { question: string; sourceLabel: string; sourceKind?: DecisionSourceKind },
  t: typeof translate,
): string {
  return notification.sourceKind === 'worktree'
    ? t('decision.worktree.question', { branch: notification.sourceLabel })
    : notification.question
}
