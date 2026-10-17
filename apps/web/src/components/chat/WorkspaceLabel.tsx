import type { WorktreeDto } from '@sillage/protocol'
import { FolderGit2, GitBranch, TriangleAlert } from 'lucide-react'
import { useTranslate } from '../../lib/i18n'
import { setPanelOpen, setPanelTab } from '../../lib/panel'
import { Tooltip } from '../ui/Tooltip'
import { cx } from '../ui'

/**
 * Branche et worktree où travaille l'agent, à côté du projet au-dessus du titre.
 *
 * Montrée aussi à la racine du projet : c'est là qu'elle sert le plus, l'arbre
 * principal pouvant être resté sur une autre branche que celle qu'on croit. Le nom du
 * worktree ne s'ajoute que s'il diffère de la branche, sinon on lirait deux fois la
 * même chose. Le clic ouvre l'onglet Git, la suite naturelle de la question.
 */
export function WorkspaceLabel({
  worktreeId,
  worktree,
  worktreesLoaded,
  projectGit,
  projectPath,
}: {
  worktreeId: string | null
  worktree: WorktreeDto | undefined
  worktreesLoaded: boolean
  projectGit: { branch: string; isDirty: boolean } | null | undefined
  projectPath: string | undefined
}) {
  const t = useTranslate()

  // Liste pas encore chargée : rien plutôt qu'un « introuvable » qui clignote.
  if (worktreeId && !worktreesLoaded) return null

  // Dossier effacé hors de Sillage, ou worktree supprimé alors que le fil y pointe :
  // l'agent n'a plus de répertoire, il faut le dire plutôt que taire la branche.
  if (worktreeId && !worktree?.git) {
    return (
      <span className="flex min-w-0 items-center gap-1 text-critical">
        <TriangleAlert size={11} className="shrink-0" />
        <span className="truncate">{t('conversation.workspace.missing', { name: worktree?.name ?? '…' })}</span>
      </span>
    )
  }

  const git = worktree ? worktree.git : projectGit
  // Projet hors dépôt : il n'y a pas de branche à montrer.
  if (!git) return null

  const detached = git.branch === 'HEAD'
  const branch = detached ? t('conversation.workspace.detached') : git.branch
  const extraName = worktree && worktree.name !== git.branch ? worktree.name : null
  const path = worktree?.path ?? projectPath
  const label = [
    worktree ? t('conversation.meta.worktree', { name: worktree.name }) : t('conversation.meta.projectFolder'),
    t('conversation.workspace.branch', { branch }),
    git.isDirty ? t('conversation.workspace.dirty') : null,
    path,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        onClick={() => {
          setPanelTab('git')
          setPanelOpen(true)
        }}
        className="flex min-w-0 items-center gap-1 rounded-sm hover:text-ink focus-visible:outline-2 focus-visible:outline-accent"
      >
        {worktree ? <FolderGit2 size={11} className="shrink-0" /> : <GitBranch size={11} className="shrink-0" />}
        {extraName ? <span className="max-w-[40%] shrink-0 truncate">{extraName}</span> : null}
        {extraName ? <span className="shrink-0 opacity-60">/</span> : null}
        <span className={cx('min-w-0 truncate font-mono', detached && 'italic')}>{branch}</span>
        {git.isDirty ? <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-caution" /> : null}
      </button>
    </Tooltip>
  )
}
