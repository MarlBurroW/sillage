import { BrushCleaning, FolderGit2, TriangleAlert } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import type { ConversationDto, WorktreeStatusDto } from '@sillage/protocol'
import { AgentIcon } from './AgentIcon'
import { SignalDot } from './chat/Signals'
import { Badge, Banner, Button, Card, CardBody, CardHeader, ConfirmDialog, Switch, cx } from './ui'
import { WorktreeStateMark, WORKTREE_STATE_TONE } from './WorktreeTag'
import { useConversations } from '../lib/conversations'
import { useLiveStatus } from '../lib/conversation-status'
import { relativeDate } from '../lib/dates'
import { translate, useTranslate } from '../lib/i18n'
import { buildSidebarSignals, presentSignal } from '../lib/signals'
import { useUpdateCard } from '../lib/cards'
import { ApiRequestError } from '../lib/api'
import { useCleanWorktree, useWorktreeCleanupPlan, useWorktreeStatuses } from '../lib/worktrees'

/**
 * La vue des chantiers d'un projet : chaque arbre que git ou Sillage connaît, son état
 * contre la branche par défaut, ses indicateurs, les sessions qui y tiennent et leur
 * carte.
 *
 * Remplace l'ancienne liste des worktrees, qui ne voyait que ceux créés par Sillage et
 * n'en disait que « propre » ou « modifié » : la question qui se pose devant des
 * arbres qui s'accumulent est « lequel porte encore du travail », et c'est elle que
 * la vue répond en premier, les plus urgents en tête.
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
    // Les plus récemment actives d'abord : ce sont elles qui disent où en est le travail.
    .sort((a, b) => b.conversation.updatedAt - a.conversation.updatedAt)
  const state = t(`worktrees.state.${tree.state}`)

  // Les indicateurs, dans l'ordre où ils pèsent : ce qui reste ici, puis l'écart à la
  // base, puis l'ancienneté. Un zéro n'apprend rien et ne s'écrit pas.
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
      {/* Nettoyer, connu de Sillage ou non : l'arbre est à git, pas à la base. */}
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
        <CleanupDialog projectId={projectId} tree={tree} base={base} onClose={() => setCleaning(false)} />
      ) : null}
    </li>
  )
}

/** Une session rattachée : son état du moment, son titre, comment elle tient à l'arbre, sa carte. */
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
  | 'worktrees.clean.sessions'
  | 'worktrees.clean.services'
  | 'worktrees.clean.terminals'

function plural(prefix: PluralPrefix, count: number): string {
  return translate(`${prefix}.${count > 1 ? 'many' : 'one'}`, { count })
}

/**
 * La confirmation du nettoyage : ce qui serait perdu, et les gestes qui l'accompagnent,
 * chacun débrayable. Le plan est relu à l'ouverture, parce que ce qui tourne dans
 * l'arbre et les sessions qui y tiennent changent d'une minute à l'autre.
 *
 * La carte passe en Terminé par le geste ordinaire du board, depuis le client : la
 * colonne reste un geste humain, et la synchronisation GitHub suit comme d'habitude.
 */
function CleanupDialog({
  projectId,
  tree,
  base,
  onClose,
}: {
  projectId: string
  tree: WorktreeStatusDto
  base: string | null
  onClose: () => void
}) {
  const t = useTranslate()
  const { data: plan, isPending: loading } = useWorktreeCleanupPlan(projectId, tree.path)
  const clean = useCleanWorktree(projectId)
  const updateCard = useUpdateCard(projectId)
  const [deleteBranch, setDeleteBranch] = useState(true)
  const [archiveSessions, setArchiveSessions] = useState(true)
  const [stopServices, setStopServices] = useState(true)
  const [cardDone, setCardDone] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Une carte encore ouverte se propose en Terminé, sans s'imposer : décoché par défaut.
  useEffect(() => { setCardDone(false) }, [plan?.card?.id])

  const lost: string[] = []
  if (plan) {
    if (plan.modified > 0) lost.push(plural('worktrees.modified', plan.modified))
    if (plan.untracked > 0) lost.push(plural('worktrees.untracked', plan.untracked))
    if (plan.state === 'unmerged' && plan.ahead > 0 && base) {
      lost.push(translate(plan.ahead > 1 ? 'worktrees.clean.lostCommits.many' : 'worktrees.clean.lostCommits.one', { count: plan.ahead, base }))
    }
  }
  const destructive = lost.length > 0 || (plan?.state === 'dirty')

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => { if (!open) onClose() }}
      title={t('worktrees.clean.title', { name: tree.name })}
      confirmLabel={t('worktrees.clean.confirm')}
      tone={destructive ? 'critical' : 'accent'}
      busy={!plan || clean.isPending || updateCard.isPending}
      onConfirm={() => {
        if (!plan) return
        setError(null)
        clean.mutate(
          { path: plan.path, deleteBranch: deleteBranch && plan.branchDeletable, archiveSessions, stopServices },
          {
            onSuccess: () => {
              if (cardDone && plan.card) updateCard.mutate({ id: plan.card.id, column: 'done' })
              onClose()
            },
            onError: (err) => setError(err instanceof ApiRequestError ? err.message : String(err)),
          },
        )
      }}
    >
      {!plan ? (
        <p className="text-ink-faint">{loading ? t('worktrees.clean.loading') : null}</p>
      ) : (
        <>
          <p>{plan.state === 'missing' ? t('worktrees.clean.missingFolder') : t('worktrees.clean.intro')}</p>
          {lost.length > 0 ? (
            <Banner tone="critical">
              <span className="font-medium">{t('worktrees.clean.lost')}</span>
              {' · '}
              {lost.join(' · ')}
            </Banner>
          ) : plan.state !== 'missing' ? (
            <p className="text-ink-faint">{t('worktrees.clean.nothingLost')}</p>
          ) : null}
          <ul className="flex flex-col gap-1.5">
            {plan.branch ? (
              <CleanupChoice
                label={plan.branchDeletable ? t('worktrees.clean.branch', { branch: plan.branch }) : t('worktrees.clean.branchBase')}
                checked={deleteBranch && plan.branchDeletable}
                disabled={!plan.branchDeletable}
                onChange={setDeleteBranch}
              />
            ) : null}
            {plan.conversations.length > 0 ? (
              <CleanupChoice
                label={plural('worktrees.clean.sessions', plan.conversations.length)}
                detail={plan.conversations.map((c) => c.title).join(', ')}
                checked={archiveSessions}
                onChange={setArchiveSessions}
              />
            ) : null}
            {plan.services.length > 0 ? (
              <CleanupChoice
                label={plural('worktrees.clean.services', plan.services.length)}
                detail={plan.services.map((s) => s.label).join(', ')}
                checked={stopServices}
                onChange={setStopServices}
              />
            ) : null}
            {plan.card ? (
              <CleanupChoice
                label={t('worktrees.clean.card', { number: plan.card.number })}
                detail={plan.card.title}
                checked={cardDone}
                onChange={setCardDone}
              />
            ) : null}
          </ul>
          {plan.terminals > 0 ? (
            <p className="text-ink-faint">{plural('worktrees.clean.terminals', plan.terminals)}</p>
          ) : null}
          {error ? <Banner>{t('worktrees.clean.failed', { message: error })}</Banner> : null}
        </>
      )}
    </ConfirmDialog>
  )
}

function CleanupChoice({
  label,
  detail,
  checked,
  disabled = false,
  onChange,
}: {
  label: string
  detail?: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <li className="flex items-center gap-2">
      <Switch checked={checked} onCheckedChange={onChange} label={label} disabled={disabled} />
      <span className="min-w-0 flex-1">
        <span className={cx('block', disabled && 'text-ink-faint')}>{label}</span>
        {detail ? <span className="block truncate text-xs text-ink-faint" title={detail}>{detail}</span> : null}
      </span>
    </li>
  )
}
