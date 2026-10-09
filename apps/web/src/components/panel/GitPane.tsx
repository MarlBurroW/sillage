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

/**
 * L'onglet Git : le dépôt tel qu'il est, et les gestes du quotidien dessus.
 *
 * Ce que dit le dépôt, tous auteurs confondus, donc y compris ce qu'on a modifié
 * soi-même à la main ou ce qu'un agent a écrit par une commande shell. Ce que l'agent
 * a fait tour par tour est une autre question, et vit dans l'onglet Historique.
 *
 * Les gestes sont ceux d'un client git ordinaire, ramenés à ce qu'un panneau étroit
 * peut tenir : index et commit, branches, remote, stashs, et quelques actions sur les
 * commits. Pas de graphe : les références posées sur chaque commit en disent l'essentiel,
 * et un graphe dans 390 px de large n'en dirait pas plus.
 */
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
      <div className="@container flex h-full min-h-0 min-w-0 flex-col overflow-y-auto pb-safe">
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
            <ChangesSection repo={repo} />
            <BranchesSection repo={repo} />
            <StashesSection repo={repo} />
            <CommitsSection repo={repo} />
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
