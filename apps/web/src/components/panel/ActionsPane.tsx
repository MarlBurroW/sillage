import { PanelEmptyState } from './PanelEmptyState'
import { Loader, Plus, Zap } from 'lucide-react'
import { useActions } from '../../lib/actions'
import { useTranslate } from '../../lib/i18n'
import { ActionList, useActionDialogs } from '../actions/ActionList'
import { Banner, Button, EmptyState } from '../ui'

/**
 * L'onglet Actions du panneau : la liste complète, et l'endroit où l'on en crée. Le
 * lanceur de l'en-tête montre la même liste sans quitter ce qu'on regarde.
 */
export function ActionsPane({ projectId, conversationId }: { projectId: string; conversationId?: string }) {
  const t = useTranslate()
  const { data, error, isPending } = useActions()
  const { handlers, create, dialogs, failure } = useActionDialogs(projectId, conversationId)
  const actions = (data ?? []).filter((action) => action.projectId === projectId)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {error ?? failure ? (
        <div className="p-2">
          <Banner>{(error ?? failure)?.message}</Banner>
        </div>
      ) : null}

      {isPending ? (
        <p className="flex items-center gap-1.5 px-3 py-3 text-xs text-ink-faint">
          <Loader size={12} className="animate-spin" />
          {t('actions.loading')}
        </p>
      ) : actions.length === 0 ? (
        <PanelEmptyState>
          <EmptyState
            icon={<Zap size={22} />}
            title={t('actions.empty.title')}
            description={t('actions.empty.description')}
            action={
              <Button size="sm" icon={<Plus size={14} />} onClick={create}>
                {t('actions.new')}
              </Button>
            }
          />
        </PanelEmptyState>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <ActionList actions={actions} conversationId={conversationId} handlers={handlers} />
        </div>
      )}

      {actions.length > 0 ? (
        <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-line py-1 pr-1.5 pl-3">
          <p className="min-w-0 truncate text-[0.6875rem] text-ink-faint">
            {t(conversationId ? 'actions.where.worktree' : 'actions.where.root')}
          </p>
          <Button size="sm" variant="ghost" icon={<Plus size={14} />} onClick={create}>
            {t('actions.new')}
          </Button>
        </footer>
      ) : null}

      {dialogs}
    </div>
  )
}
