import { BrushCleaning, FolderGit2, TriangleAlert } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { ConversationDto, WorktreeStatusDto } from '@sillage/protocol'
import { AgentIcon } from './AgentIcon'
import { SignalDot } from './chat/Signals'
import { Badge, Button, Card, CardBody, CardHeader, cx } from './ui'
import { WorktreeCleanupDialog } from './WorktreeCleanupDialog'
import { WorktreeStateMark, WORKTREE_STATE_TONE } from './WorktreeTag'
import { useConversations } from '../lib/conversations'
import { useLiveStatus } from '../lib/conversation-status'
import { relativeDate } from '../lib/dates'
import { translate, useTranslate } from '../lib/i18n'
import { buildSidebarSignals, presentSignal } from '../lib/signals'
import { useWorktreeStatuses } from '../lib/worktrees'

/**
 * Project worktrees known to Git or Sillage, their default-branch relationship, metrics, sessions,
 * and cards. Replaces Sillage-created-only clean/dirty lists: accumulated trees first raise which
 * still contains work, ordered by urgency.
 */
export function WorktreeBoard({ projectId, isRepository }: { projectId: string; isRepository: boolean }) {
  const t = useTranslate()
  const { data } = useWorktreeStatuses(isRepository ? projectId : undefined)
  const { data: conversations } = useConversations(isRepository ? projectId : undefined)
  const byId = useMemo(() => new Map((conversations ?? []).map((c) => [c.id, c])), [conversations])

  if (!isRepository || !data || data.worktrees.length === 0) return null

  const base = data.base
  return (
    <Card>
      <div id="worktrees" className="scroll-mt-4" />
      <CardHeader
        title={t('worktrees.board.title')}
        description={base ? t('worktrees.board.description', { base }) : t('worktrees.board.descriptionNoBase')}
        icon={<FolderGit2 size={16} />}
      />
      <CardBody className="flex flex-col gap-1">
        {!data.fresh ? <p className="text-xs text-ink-faint">{t('worktrees.board.refreshing')}</p> : null}
        <ul className="flex flex-col divide-y divide-line">
          {data.worktrees.map((tree) => (
            <WorktreeRow key={tree.path} projectId={projectId} tree={tree} base={base} byId={byId} />
          ))}
        </ul>
      </CardBody>
    </Card>
  )
}

function WorktreeRow({
  projectId,
  tree,
  base,
  byId,
}: {
  projectId: string
  tree: WorktreeStatusDto
  base: string | null
  byId: Map<string, ConversationDto>
}) {
  const t = useTranslate()
  const [cleaning, setCleaning] = useState(false)
  const linked = tree.conversations
    .map((entry) => ({ ...entry, conversation: byId.get(entry.id) }))
    .filter((entry): entry is typeof entry & { conversation: ConversationDto } => entry.conversation !== undefined)
    // Most recently active first because they best indicate work progress.
    .sort((a, b) => b.conversation.updatedAt - a.conversation.updatedAt)
  const state = t(`worktrees.state.${tree.state}`)

  // Metrics ordered by significance: remaining work, divergence, then age. Omit meaningless zeros.
  const facts: string[] = []
  if (tree.modified > 0) facts.push(plural('worktrees.modified', tree.modified))
  if (tree.untracked > 0) facts.push(plural('worktrees.untracked', tree.untracked))
  if (tree.ahead > 0) facts.push(plural('worktrees.ahead', tree.ahead))
  if (tree.behind > 0) facts.push(plural('worktrees.behind', tree.behind))
  if (tree.lastEditAt) facts.push(t('worktrees.lastEdit', { when: relativeDate(tree.lastEditAt) }))
  else if (tree.lastCommitAt) facts.push(t('worktrees.lastCommit', { when: relativeDate(tree.lastCommitAt) }))

  return (
    <li className="flex flex-col gap-2 py-3 first:pt-1 last:pb-1 sm:flex-row sm:items-start sm:gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <WorktreeStateMark state={tree.state} className="size-2" />
          <span className="min-w-0 truncate font-mono text-sm text-ink" title={tree.path}>
            {tree.name}
          </span>
          <Badge tone={WORKTREE_STATE_TONE[tree.state]}>{state}</Badge>
          {tree.external ? <Badge>{t('worktrees.external')}</Badge> : null}
          {tree.conflicts && base ? (
            <Badge tone="critical" icon={<TriangleAlert size={11} />}>
              {t('worktrees.conflicts', { base })}
            </Badge>
          ) : null}
        </div>
        {facts.length > 0 ? (
          <p className="mt-1 text-xs text-ink-faint">{facts.join(' · ')}</p>
        ) : null}
        <p className="mt-0.5 truncate text-[0.6875rem] text-ink-faint" title={tree.path}>
          {tree.path}
        </p>
        <ul className="mt-1.5 flex flex-col gap-0.5">
          {linked.length === 0 ? (
            <li className="text-xs text-ink-faint">{t('worktrees.sessions.none')}</li>
          ) : (
            linked.map((entry) => (
              <LinkedSession key={entry.id} conversation={entry.conversation} link={entry.link} />
            ))
          )}
        </ul>
      </div>
      {/* Clean trees whether known to Sillage or not: Git owns them, not the database. */}
      <Button
        variant="ghost"
        size="sm"
        icon={<BrushCleaning size={15} />}
        className="shrink-0 self-start"
        onClick={() => setCleaning(true)}
      >
        {t('worktrees.clean')}
      </Button>
      {cleaning ? (
        <WorktreeCleanupDialog projectId={projectId} tree={tree} base={base} onClose={() => setCleaning(false)} />
      ) : null}
    </li>
  )
}

/** Associated session with current status, title, tree relationship, and card. */
function LinkedSession({ conversation, link }: { conversation: ConversationDto; link: 'worktree' | 'edited' }) {
  const t = useTranslate()
  const status = useLiveStatus(conversation.id) ?? conversation.status
  const signal = presentSignal(buildSidebarSignals({ status, background: 0, loops: 0 }))
  return (
    <li className="flex min-w-0 items-center gap-1.5 text-xs">
      <span className="flex w-2 shrink-0 justify-center">{signal ? <SignalDot signal={signal} /> : null}</span>
      <span className="shrink-0 text-ink-faint">
        <AgentIcon agent={conversation.agent} size={12} />
      </span>
      <Link
        to={`/p/${conversation.projectId}/c/${conversation.id}`}
        className={cx('min-w-0 truncate hover:underline', conversation.archivedAt ? 'text-ink-faint' : 'text-ink-soft')}
      >
        {conversation.title}
      </Link>
      <span className="shrink-0 text-ink-faint">· {t(`worktrees.link.${link}`)}</span>
      {conversation.card ? (
        <Link
          to={`/p/${conversation.projectId}/board?carte=${conversation.card.number}`}
          className="shrink-0 text-accent hover:underline"
          title={conversation.card.title}
        >
          {t('worktrees.card', { number: conversation.card.number })}
        </Link>
      ) : null}
    </li>
  )
}

type PluralPrefix =
  | 'worktrees.modified'
  | 'worktrees.untracked'
  | 'worktrees.ahead'
  | 'worktrees.behind'

function plural(prefix: PluralPrefix, count: number): string {
  return translate(`${prefix}.${count > 1 ? 'many' : 'one'}`, { count })
}
