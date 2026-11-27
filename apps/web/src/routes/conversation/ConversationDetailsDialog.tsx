import * as Dialog from '@radix-ui/react-dialog'
import { Link } from 'react-router-dom'
import { FolderTree, GitBranch, SquareKanban, Terminal, TriangleAlert, X } from 'lucide-react'
import {
  conversationPath,
  type ClaudeAccountDto,
  type ConversationDto,
  type HandoffDto,
  type WorktreeDto,
} from '@sillage/protocol'
import type { ChatState } from '@sillage/protocol/chat-state'
import { AGENT_LABELS, AgentIcon } from '../../components/AgentIcon'
import { UsageSummary } from '../../components/chat/UsageSummary'
import { IconButton } from '../../components/ui'
import { sessionVersionGap } from '../../lib/session-version'
import { useTranslate } from '../../lib/i18n'

/** “Details” dialog: model, workspace, origin, card, API control, handoff block and usage. */
export function ConversationDetailsDialog({
  open,
  onOpenChange,
  conversation,
  state,
  worktree,
  origin,
  continued,
  handoff,
  billingAccount,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  conversation: ConversationDto
  state: ChatState
  worktree: WorktreeDto | undefined
  /** Conversation this one was forked from. */
  origin: ConversationDto | undefined
  /** Conversation this one continues in another CLI. */
  continued: ConversationDto | undefined
  handoff: HandoffDto | undefined
  billingAccount: ClaudeAccountDto | null | undefined
}) {
  const t = useTranslate()
  const versionGap = sessionVersionGap(conversation.agent, state.cliVersion)

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/60 backdrop-blur-[2px]" />
        <Dialog.Content
          aria-describedby={undefined}
          className="surface fixed top-1/2 left-1/2 z-50 max-h-[85dvh] w-[min(30rem,92vw)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-line p-4 shadow-pop"
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <Dialog.Title className="text-sm font-semibold">{t('conversation.meta.details')}</Dialog.Title>
            <Dialog.Close asChild>
              <IconButton label={t('common.close')}><X size={18} /></IconButton>
            </Dialog.Close>
          </div>
          <p className="mb-3 break-words text-sm text-ink-soft">{conversation.title}</p>
          <div className="flex flex-wrap items-center gap-2 text-xs text-ink-soft">
            <Meta title={AGENT_LABELS[conversation.agent]}>
              {state.model ?? AGENT_LABELS[conversation.agent]}
            </Meta>

            {/*
             * The version of the process holding the conversation, not of the binary installed
             * now: after a CLI update, an open session keeps the old one until its process exits,
             * and nothing else on screen says so. Shown only when the CLI reports it.
             */}
            {state.cliVersion ? (
              <Meta
                icon={versionGap ? <TriangleAlert size={10} className="text-caution" /> : undefined}
                title={versionGap ?? t('conversation.meta.cliVersion', { agent: AGENT_LABELS[conversation.agent] })}
              >
                {state.cliVersion}
              </Meta>
            ) : null}

            <Meta
              icon={worktree ? <GitBranch size={10} /> : <FolderTree size={10} />}
              title={
                worktree
                  ? t('conversation.meta.worktree', { name: worktree.name })
                  : t('conversation.meta.projectFolder')
              }
            >
              {worktree ? worktree.name : t('conversation.meta.project')}
            </Meta>

            {/*
             * Forks show their origin: otherwise two nearly identical sidebar threads
             * cannot be distinguished. The link disappears if the original is deleted and
             * the reference becomes orphaned.
             */}
            {origin ? (
              <Link
                to={conversationPath(origin)}
                className="flex shrink-0 items-center gap-1 rounded-full bg-surface-high px-1.5 py-0.5 hover:text-ink"
                title={t('conversation.meta.branchOf', { title: origin.title })}
              >
                <GitBranch size={10} />
                <span className="max-w-32 truncate">{origin.title}</span>
              </Link>
            ) : null}

            {/*
             * Continuations show their source thread and CLI, explaining why the agent
             * knows work not visible in this thread.
             */}
            {continued ? (
              <Link
                to={conversationPath(continued)}
                className="flex shrink-0 items-center gap-1 rounded-full bg-surface-high px-1.5 py-0.5 hover:text-ink"
                title={t('conversation.meta.continues', { title: continued.title, agent: AGENT_LABELS[continued.agent] })}
              >
                <AgentIcon agent={continued.agent} size={10} />
                <span className="max-w-32 truncate">{continued.title}</span>
              </Link>
            ) : null}

            {/*
             * Route back to the work item: from a session to its card. Use the card title
             * at load time, not a copy frozen at creation.
             */}
            {conversation.card ? (
              <Link
                to={`/p/${conversation.projectId}/board?carte=${conversation.card.number}`}
                className="flex shrink-0 items-center gap-1 rounded-full bg-surface-high px-1.5 py-0.5 hover:text-ink"
                title={t('conversation.meta.card', { title: conversation.card.title })}
              >
                <SquareKanban size={10} />
                <span>#{conversation.card.number}</span>
              </Link>
            ) : null}

            {/*
             * Explicitly identify API-launched conversations: users can write in them
             * normally, but remote agents also control them. Discovering an unsolicited
             * turn without knowing its origin is the worst way to learn this.
             */}
            {/*
             * Not `Meta`: it uses monospace and truncates at 10rem, cutting the sentence
             * midway. The sentence must be readable in full to be useful.
             */}
            {conversation.origin ? (
              <span className="flex min-w-0 items-center gap-1 rounded-full bg-accent-wash px-1.5 py-0.5 text-accent">
                <Terminal size={10} />
                {t('conversation.meta.apiControlled', { label: conversation.origin.label })}
              </span>
            ) : null}

            {/*
             * What a continuation knows of its source: the exact received block, allowing
             * users to check omissions before repeating them.
             */}
            {handoff ? (
              <details className="basis-full text-xs">
                <summary className="cursor-pointer text-ink-soft">
                  {t('conversation.meta.handoff')} ·{' '}
                  {t('conversation.meta.handoffSize', {
                    kilobytes: Math.max(1, Math.round(handoff.bytes / 1000)),
                    budget: Math.round(handoff.budgetTokens / 1000),
                  })}
                </summary>
                <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-sunken p-2 text-[0.6875rem] whitespace-pre-wrap text-ink-soft">
                  {handoff.text}
                </pre>
              </details>
            ) : null}

            {/*
             * Everything comes from the fold: the journal is the sole display source (I2)
             * and alone carries cache-token details.
             */}
            <UsageSummary
              account={billingAccount}
              rateLimit={state.rateLimit}
              costUsd={state.costUsd}
              inputTokens={state.inputTokens}
              outputTokens={state.outputTokens}
              cacheCreationTokens={state.cacheCreationTokens}
              cacheReadTokens={state.cacheReadTokens}
            />
          </div>
          {/* Spelled out, not only in the tooltip: phones have no hover. */}
          {versionGap ? (
            <p className="mt-3 flex items-start gap-1.5 text-xs text-caution">
              <TriangleAlert size={12} className="mt-0.5 shrink-0" />
              <span>{state.cliVersion} · {versionGap}</span>
            </p>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function Meta({
  icon,
  title,
  children,
}: {
  icon?: React.ReactNode
  title: string
  children: React.ReactNode
}) {
  return (
    <span
      title={title}
      className="flex shrink-0 items-center gap-1 rounded-full bg-surface-high px-1.5 py-0.5"
    >
      {icon}
      <span className="max-w-40 truncate font-mono">{children}</span>
    </span>
  )
}
