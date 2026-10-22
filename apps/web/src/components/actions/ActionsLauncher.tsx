import { PanelRight, Plus, Zap } from 'lucide-react'
import { useState } from 'react'
import { actionView, useActions } from '../../lib/actions'
import { useTranslate } from '../../lib/i18n'
import { setPanelOpen, setPanelTab } from '../../lib/panel'
import { Banner, Button, Popover, cx } from '../ui'
import { TooltipButton } from '../ui/Tooltip'
import { ActionList, useActionDialogs, type ActionHandlers } from './ActionList'

/**
 * Header project-action launcher available everywhere without panel navigation. Lightning counts
 * running services, including forgotten development servers; badges also identify actions awaiting
 * user review.
 */
export function ActionsLauncher({ projectId, conversationId, size = 'md' }: {
  projectId: string
  conversationId?: string
  size?: 'sm' | 'md'
}) {
  const t = useTranslate()
  const { data } = useActions()
  const [open, setOpen] = useState(false)
  const { handlers, create, dialogs, failure } = useActionDialogs(projectId, conversationId)
  // Dialogs opened from popovers close them, so own dialogs outside.
  const closing: ActionHandlers = {
    onReview: (action) => { setOpen(false); handlers.onReview(action) },
    onEdit: (action) => { setOpen(false); handlers.onEdit(action) },
    onDelete: (action) => { setOpen(false); handlers.onDelete(action) },
  }
  const actions = (data ?? []).filter((action) => action.projectId === projectId)
  const running = actions.filter((action) => action.kind === 'service' && actionView(action).live).length
  const proposed = actions.some((action) => action.status === 'proposed')

  const label = running > 0 ? t('actions.launcher.labelRunning', { count: running }) : t('actions.launcher.label')

  return (
    <>
      <Popover
        open={open}
        onOpenChange={setOpen}
        label={t('actions.launcher.label')}
        side="bottom"
        align="end"
        className="w-[min(22rem,calc(100vw-1.5rem))] p-0"
        trigger={
          <TooltipButton
            type="button"
            aria-label={label}
            title={label}
            className={cx(
              'relative inline-flex shrink-0 items-center justify-center gap-1 rounded-md text-ink-faint transition-colors hover:bg-surface-high hover:text-ink',
              size === 'sm' ? 'h-11 min-w-11 px-2 md:h-7 md:min-w-7 pointer-coarse:h-11' : 'h-11 min-w-11 px-2',
              open && 'text-accent',
            )}
          >
            <Zap size={size === 'sm' ? 16 : 18} className={cx(running > 0 && 'text-positive')} />
            {running > 0 ? <span className="text-xs font-semibold tabular-nums text-positive">{running}</span> : null}
            {proposed ? (
              <span className="absolute top-2 right-1.5 size-2 rounded-full bg-caution ring-2 ring-surface md:top-1" />
            ) : null}
          </TooltipButton>
        }
      >
        <div className="flex max-h-[min(28rem,70dvh)] flex-col">
          <header className="flex items-center justify-between gap-2 border-b border-line py-1.5 pr-1.5 pl-3">
            <p className="text-sm font-semibold text-ink">{t('actions.launcher.label')}</p>
            <Button
              size="sm"
              variant="ghost"
              icon={<PanelRight size={14} />}
              onClick={() => {
                setOpen(false)
                setPanelTab('actions')
                setPanelOpen(true)
              }}
            >
              {t('actions.launcher.manage')}
            </Button>
          </header>
          {failure ? (
            <div className="px-3 pt-2">
              <Banner>{failure.message}</Banner>
            </div>
          ) : null}
          {actions.length === 0 ? (
            <div className="flex flex-col items-start gap-2 px-3 py-3">
              <p className="text-xs text-ink-faint">{t('actions.empty.description')}</p>
              <Button size="sm" icon={<Plus size={14} />} onClick={() => { setOpen(false); create() }}>
                {t('actions.new')}
              </Button>
            </div>
          ) : (
            <div className="min-h-0 overflow-y-auto">
              <ActionList actions={actions} conversationId={conversationId} handlers={closing} compact />
            </div>
          )}
        </div>
      </Popover>
      {dialogs}
    </>
  )
}
