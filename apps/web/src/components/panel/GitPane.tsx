import './git/git-workspace.css'
import { GitBranch, Loader, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { GitActionDto } from '@sillage/protocol'
import { useGitAction, useGitStatus, useRefreshGit } from '../../lib/git'
import { useTranslate } from '../../lib/i18n'
import { Banner, Button, EmptyState, IconButton } from '../ui'
import { BranchesSection } from './git/BranchesSection'
import { ChangesSection } from './git/ChangesSection'
import { CommitsSection } from './git/CommitsSection'
import { GitContext, type GitNotice } from './git/context'
import { OperationBanner, RepoHeader } from './git/RepoHeader'
import { StashesSection } from './git/StashesSection'

/** Le graphe garde sa place pendant que l’on inspecte un commit ou prépare le suivant. */
export function GitPane({
  scope,
  turnRunning,
  onOpenFile,
}: {
  scope: string
  turnRunning: boolean
  onOpenFile: (path: string) => void
}) {
  const t = useTranslate()
  const [view, setView] = useState<'graph' | 'work'>('graph')
  const status = useGitStatus(scope)
  const refresh = useRefreshGit(scope)
  const [notice, setNotice] = useState<GitNotice | null>(null)

  // Un tour qui se termine a pu commiter, changer de branche, tout réécrire : on relit.
  const wasRunning = useRef(turnRunning)
  useEffect(() => {
    if (wasRunning.current && !turnRunning) refresh()
    wasRunning.current = turnRunning
  }, [turnRunning, refresh])

  // Un succès n'a pas à rester affiché : il s'efface seul. Un échec attend d'être lu.
  useEffect(() => {
    if (!notice || notice.tone === 'critical') return
    const timer = setTimeout(() => setNotice(null), 6000)
    return () => clearTimeout(timer)
  }, [notice])

  const repo = status.data?.repo ?? null

  return (
    <GitContext.Provider value={{ scope, notify: setNotice, openFile: onOpenFile }}>
      {/* `@container` : l'auteur d'un commit et les dates ne s'affichent que si la ligne
          a la place, qui dépend de la largeur du panneau et non de celle de la fenêtre. */}
      <div className="git-workspace @container flex h-full min-h-0 min-w-0 flex-col overflow-hidden pb-safe">
        {status.isPending ? (
          <p className="flex items-center gap-1.5 px-2.5 py-2 text-xs text-ink-faint">
            <Loader size={11} className="animate-spin" />
            {t('changes.diff.loading')}
          </p>
        ) : null}

        {status.error ? (
          <div className="p-2">
            <Banner>{status.error instanceof Error ? status.error.message : t('changes.diff.error')}</Banner>
          </div>
        ) : null}

        {status.data && repo === null ? <NotARepository scope={scope} /> : null}

        {repo ? (
          <>
            <RepoHeader repo={repo} refreshing={status.isFetching} onRefresh={refresh} />
            {notice ? <Notice notice={notice} onDismiss={() => setNotice(null)} /> : null}
            <OperationBanner repo={repo} />
            <div
              className="flex shrink-0 gap-1 border-b border-line p-2 @min-[60rem]:hidden"
              role="group"
              aria-label={t('git.graph.views')}
            >
              <Button
                size="sm"
                variant={view === 'graph' ? 'primary' : 'ghost'}
                aria-pressed={view === 'graph'}
                onClick={() => setView('graph')}
              >
                {t('git.graph.title')}
              </Button>
              <Button
                size="sm"
                variant={view === 'work' ? 'primary' : 'ghost'}
                aria-pressed={view === 'work'}
                onClick={() => setView('work')}
              >
                {t('git.graph.work')}{' '}
                {repo.staged.length + repo.unstaged.length + repo.conflicted.length || ''}
              </Button>
            </div>
            <div className="flex min-h-0 flex-1">
              <div
                className={`git-work-sidebar ${view === 'work' ? 'flex' : 'hidden'} min-h-0 w-full shrink-0 flex-col overflow-auto @min-[60rem]:flex @min-[60rem]:w-[17rem] @min-[60rem]:border-r @min-[60rem]:border-line`}
              >
                <ChangesSection repo={repo} />
                <BranchesSection repo={repo} />
                <StashesSection repo={repo} />
              </div>
              <div
                className={`${view === 'graph' ? 'flex' : 'hidden'} min-h-0 min-w-0 flex-1 @min-[60rem]:flex`}
              >
                <CommitsSection key={scope} repo={repo} />
              </div>
            </div>
          </>
        ) : null}
      </div>
    </GitContext.Provider>
  )
}

/** Ce qu'une action a donné, avec ses remèdes quand il y en a. */
function Notice({ notice, onDismiss }: { notice: GitNotice; onDismiss: () => void }) {
  const t = useTranslate()
  return (
    <div className="p-2">
      <Banner tone={notice.tone}>
        <span className="flex items-start gap-2">
          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="break-words">{notice.text}</span>
            {notice.actions?.length ? (
              <span className="flex flex-wrap gap-1.5">
                {notice.actions.map((action) => (
                  <Button
                    key={action.label}
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      onDismiss()
                      action.run()
                    }}
                  >
                    {action.label}
                  </Button>
                ))}
              </span>
            ) : null}
          </span>
          <IconButton label={t('git.notice.dismiss')} size="sm" onClick={onDismiss} className="-my-1 -mr-1">
            <X size={14} />
          </IconButton>
        </span>
      </Banner>
    </div>
  )
}

/**
 * Le répertoire n'est pas un dépôt : on le dit, et on propose d'en faire un. Un
 * projet créé depuis Sillage sans clone en est là, et c'est le premier geste qu'on
 * ferait dans un terminal.
 */
function NotARepository({ scope }: { scope: string }) {
  const t = useTranslate()
  const init = useGitAction<void, GitActionDto>(scope, 'init')
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="flex min-h-0 flex-1 items-center p-4">
      <EmptyState
        icon={<GitBranch size={22} />}
        title={t('changes.diff.notGitRepo')}
        description={error ?? t('git.init.description')}
        action={
          <Button
            size="sm"
            disabled={init.isPending}
            onClick={() =>
              init.mutate(undefined, {
                onError: (err) => setError(err instanceof Error ? err.message : t('git.action.failed')),
              })
            }
          >
            {init.isPending ? t('git.init.pending') : t('git.init.action')}
          </Button>
        }
      />
    </div>
  )
}
