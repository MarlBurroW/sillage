import { Play, ShieldQuestion, Zap } from 'lucide-react'
import type { ToolItem } from '../../lib/chat-fold'
import { actionView, describeActionState, useActions, useRunAction } from '../../lib/actions'
import { useConversation } from '../../lib/conversations'
import { useTranslate } from '../../lib/i18n'
import { registeredActionIdOf } from '../../lib/sillage-tools'
import { useActionDialogs } from '../actions/ActionList'
import { outputText } from '../tools/payload'
import { Button } from '../ui'

/**
 * Below register_action calls, the action the agent proposed: reviewed and launched from the
 * thread, where the user reads the agent's reasons, instead of waiting behind a dot on the
 * Actions button that nobody connects to it. Reads live state, so a review done elsewhere shows.
 */
export function ActionProposalStrip({ tool, conversationId }: { tool: ToolItem; conversationId: string }) {
  const t = useTranslate()
  const { data: actions } = useActions()
  const { data: conversation } = useConversation(conversationId)
  const id = registeredActionIdOf(tool.input, outputText(tool.output))
  const action = id ? actions?.find((candidate) => candidate.id === id) : undefined
  // Runs in this conversation's worktree, unless the action belongs to another project.
  const here = action && conversation?.projectId === action.projectId ? conversationId : undefined
  const { handlers, dialogs } = useActionDialogs(action?.projectId ?? '', here)
  const run = useRunAction()
  // Deleted since: nothing left to review or run.
  if (!action) return null

  if (action.status === 'proposed') {
    return (
      <div className="flex flex-wrap items-center gap-2 border-t border-caution/35 bg-caution/10 px-2.5 py-2 text-xs text-caution" data-action-proposal>
        <ShieldQuestion size={14} className="shrink-0" />
        <span className="min-w-0 flex-1">{t('actions.inline.pending', { label: action.label })}</span>
        <Button size="sm" variant="secondary" onClick={() => handlers.onReview(action)}>
          {t('actions.review')}
        </Button>
        {dialogs}
      </div>
    )
  }

  const view = actionView(action)
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-line px-2.5 py-1.5 text-[0.6875rem] text-ink-faint" data-action-proposal>
      <Zap size={12} className="shrink-0 text-accent" />
      <span className="min-w-0 flex-1">
        {t('actions.inline.ready', { label: action.label })} · {describeActionState(action, t)}
      </span>
      {view.primary === 'run' ? (
        <Button
          size="sm"
          variant="ghost"
          icon={<Play size={13} />}
          disabled={run.isPending}
          onClick={() => run.mutate({ action, conversationId: here })}
        >
          {t('actions.run')}
        </Button>
      ) : null}
    </div>
  )
}
