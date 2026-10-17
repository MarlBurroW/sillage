import type { ConversationDto, WorktreeState } from '@sillage/protocol'
import { useTranslate } from '../lib/i18n'
import { setPanelOpen, setPanelTab } from '../lib/panel'
import { useConversationWorktree } from '../lib/worktrees'
import { cx } from './ui'

/**
 * Couleur d'un état de chantier, partagée entre la ligne de la barre latérale et la
 * vue des chantiers pour que le même mot ait la même teinte partout.
 */
export const WORKTREE_STATE_COLOR: Record<WorktreeState, string> = {
  missing: 'bg-critical',
  dirty: 'bg-caution',
  unmerged: 'bg-accent',
  merged: 'bg-positive',
}

export const WORKTREE_STATE_TONE: Record<WorktreeState, 'critical' | 'caution' | 'accent' | 'positive'> = {
  missing: 'critical',
  dirty: 'caution',
  unmerged: 'accent',
  merged: 'positive',
}

/**
 * Le repère d'état d'un arbre : un carré plein, sans arrondi, pour ne pas se confondre
 * avec les points de signal de la ligne, qui parlent de l'instant et non de l'arbre.
 */
export function WorktreeStateMark({ state, className }: { state: WorktreeState; className?: string }) {
  return <span aria-hidden className={cx('size-1.5 shrink-0', WORKTREE_STATE_COLOR[state], className)} />
}

/**
 * La branche et l'état de l'arbre d'une session, sous son titre dans la barre latérale.
 *
 * Rien pour une session de l'arbre principal : c'est l'absence qui fait ressortir les
 * autres d'un coup d'œil. Le clic ouvre l'onglet Git du fil, la suite naturelle de la
 * question « où en est cet arbre ». Pas un bouton : la ligne est déjà un lien, et un
 * bouton dedans serait invalide ; le lien navigue, et le geste choisit l'onglet.
 */
export function WorktreeTag({ conversation }: { conversation: Pick<ConversationDto, 'id' | 'projectId'> }) {
  const t = useTranslate()
  const tree = useConversationWorktree(conversation)
  if (!tree) return null

  const state = t(`worktrees.state.${tree.state}`)
  return (
    <span
      role="note"
      aria-label={t('shell.conversation.worktree', { name: tree.name, state })}
      title={`${tree.name} · ${state}\n${tree.path}`}
      onClick={() => {
        setPanelTab('git')
        setPanelOpen(true)
      }}
      className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[0.6875rem] leading-4 text-ink-faint hover:text-ink-soft"
    >
      <WorktreeStateMark state={tree.state} />
      <span className="min-w-0 truncate font-mono">{tree.name}</span>
      <span className="shrink-0">· {state}</span>
    </span>
  )
}
