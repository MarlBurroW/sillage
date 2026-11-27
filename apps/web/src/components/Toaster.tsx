import { conversationPath } from '@sillage/protocol'
import { CalendarX2, CircleHelp, Hourglass, KeyRound, ShieldQuestion, X } from 'lucide-react'
import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import type { CliRequestKind, InAppNotification } from '@sillage/protocol'
import { openDecision, useDecisions } from '../lib/decisions'
import { locale, useTranslate, type MessageKey } from '../lib/i18n'
import { dismissDecisionToasts, dismissToast, pushToast, useToasts } from '../lib/toasts'
import { describeUsageLimitStop } from '../lib/usage-limit'
import { wsClient } from '../lib/ws-client'
import { Button, IconButton } from './ui'
import { ActionRunToast } from './actions/ActionRunNotices'
import { toastQuestion } from './decisions/decision-text'

/** Summarize beyond this count: screen-covering stacks are unreadable. */
const VISIBLE = 2

const REQUEST_TITLES: Record<CliRequestKind, MessageKey> = {
  permission: 'toast.cli.permission',
  question: 'toast.cli.question',
  elicitation: 'toast.cli.elicitation',
  plan: 'toast.cli.plan',
  mcpInstall: 'toast.cli.mcpInstall',
}

/**
 * App toasts bottom-right on desktop, top on phones. Only actionable decisions, CLIs waiting
 * elsewhere and the end of action runs this tab launched belong here. Servers target visible tabs
 * and send system notifications to other devices.
 */
export function Toaster() {
  const t = useTranslate()
  const toasts = useToasts()
  const { data: pending } = useDecisions('pending')

  useEffect(() => wsClient.onNotify((notification) => pushToast(notification)), [])
  // Remove decisions resolved elsewhere through tabs, phones, or deadlines.
  useEffect(() => {
    if (pending) dismissDecisionToasts(new Set(pending.map((decision) => decision.id)))
  }, [pending])

  if (toasts.length === 0) return null
  const shown = toasts.slice(-VISIBLE).reverse()
  const hidden = toasts.length - shown.length

  return (
    <section
      aria-label={t('toast.region')}
      className="pointer-events-none fixed inset-x-3 top-[calc(env(safe-area-inset-top)+0.75rem)] z-50 flex flex-col gap-2 md:inset-x-auto md:top-auto md:right-4 md:bottom-4 md:w-[24rem]"
    >
      {shown.map((toast) =>
        toast.notification.kind === 'actionRun' ? (
          <ActionRunToast key={toast.id} id={toast.id} notice={toast.notification} />
        ) : (
          <ToastCard key={toast.id} id={toast.id} notification={toast.notification} />
        ),
      )}
      {hidden > 0 ? (
        <p className="surface pointer-events-auto rounded-lg border border-line px-3 py-2 text-xs text-ink-faint shadow-pop">
          {t('toast.more', { count: hidden })}
        </p>
      ) : null}
    </section>
  )
}

function ToastCard({ id, notification }: { id: string; notification: InAppNotification }) {
  const t = useTranslate()
  const navigate = useNavigate()
  const decision = notification.kind === 'decision'
  const limit = notification.kind === 'usageLimit'
  const expiry = notification.kind === 'credentialExpiry'
  const schedule = notification.kind === 'scheduleFailed'

  return (
    <div role="status" className="surface pointer-events-auto flex gap-3 rounded-xl border border-accent/40 p-3.5 shadow-pop">
      <span className="mt-0.5 shrink-0 text-accent">
        {decision ? <CircleHelp size={18} /> : limit ? <Hourglass size={18} /> : expiry ? <KeyRound size={18} /> : schedule ? <CalendarX2 size={18} /> : <ShieldQuestion size={18} />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium text-accent">
          {decision ? t('toast.decision.title') : limit ? t('toast.usageLimit.title') : expiry ? t('claudeAccounts.host.attention') : schedule ? t('toast.scheduleFailed.title') : t(REQUEST_TITLES[notification.request])}
        </p>
        <p className="mt-0.5 line-clamp-2 text-sm font-medium text-ink">
          {decision ? toastQuestion(notification, t) : expiry ? t('claudeAccounts.host.expires', { date: new Date(notification.loginExpiresAt).toLocaleDateString(locale()) }) : schedule ? notification.taskName : notification.conversationTitle}
        </p>
        <p className="mt-0.5 truncate text-xs text-ink-faint">
          {decision
            ? [notification.sourceLabel, notification.projectName].filter(Boolean).join(' · ')
            : expiry
              ? t('claudeAccounts.host.estimate')
              : schedule
              ? notification.error
              : limit
              ? describeUsageLimitStop(notification)
              : notification.detail}
        </p>
        <div className="mt-2.5 flex gap-2">
          <Button
            size="sm"
            onClick={() => {
              dismissToast(id)
              if (notification.kind === 'decision') openDecision(notification.decisionId)
              else if (notification.kind === 'credentialExpiry') navigate('/settings/comptes-claude')
              else if (notification.kind === 'scheduleFailed') navigate(`/p/${notification.projectId}/schedules/${notification.taskId}`)
              else navigate(conversationPath({ projectId: notification.projectId, id: notification.conversationId }))
            }}
          >
            {t(decision ? 'toast.decision.answer' : expiry ? 'claudeAccounts.host.open' : schedule ? 'toast.scheduleFailed.open' : 'toast.cli.open')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => dismissToast(id)}>
            {t('toast.later')}
          </Button>
        </div>
      </div>
      <IconButton size="sm" label={t('common.close')} onClick={() => dismissToast(id)}>
        <X size={14} />
      </IconButton>
    </div>
  )
}
