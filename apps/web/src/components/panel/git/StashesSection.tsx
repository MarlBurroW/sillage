import { Archive, ArchiveRestore, Ellipsis, Loader, Trash2, Undo2 } from 'lucide-react'
import { useState } from 'react'
import type { GitActionDto, GitRepoStatusDto, GitStashDto } from '@sillage/protocol'
import { relativeDate } from '../../../lib/dates'
import { useGitAction, useGitStashes } from '../../../lib/git'
import { useTranslate } from '../../../lib/i18n'
import { Banner, Button, ConfirmDialog, IconButton, Menu, MenuItem, MenuSeparator } from '../../ui'
import { failureNotice, useGitPane } from './context'
import { Section, useSectionOpen } from './Section'

/**
 * Les stashs : le travail mis de côté, à reprendre ou à jeter.
 *
 * `apply` et `pop` sont deux entrées distinctes et nommées par ce qu'elles font du
 * stash : la différence (garder ou retirer l'entrée) est précisément ce qu'on oublie
 * dans un terminal, et qu'on paie en stashs fantômes ou en travail perdu.
 */
export function StashesSection({ repo }: { repo: GitRepoStatusDto }) {
  const t = useTranslate()
  const { scope, notify } = useGitPane()
  const [open, toggle] = useSectionOpen('stashes', false)
  const [creating, setCreating] = useState(false)
  const stashes = useGitStashes(scope, open)
  const apply = useGitAction<{ index: number }, GitActionDto>(scope, 'stash/apply')
  const pop = useGitAction<{ index: number }, GitActionDto>(scope, 'stash/pop')
  const drop = useGitAction<{ index: number }>(scope, 'stash/drop')
  const [dropping, setDropping] = useState<GitStashDto | null>(null)
  const busy = apply.isPending || pop.isPending || drop.isPending
  const hasChanges = repo.staged.length + repo.unstaged.length > 0

  const onError = (error: unknown) => notify(failureNotice(error, t('git.action.failed')))
  const report = (result: GitActionDto) =>
    notify(
      result.conflicts
        ? { tone: 'critical', text: t('git.notice.conflicts') }
        : { tone: 'positive', text: result.summary ?? t('git.notice.done') },
    )

  const list = stashes.data?.stashes ?? []

  return (
    <Section
      title={t('git.stash.title')}
      count={repo.stashCount}
      open={open}
      onToggle={toggle}
      actions={
        <IconButton
          label={t('git.stash.new')}
          size="sm"
          disabled={!hasChanges}
          onClick={() => {
            if (!open) toggle()
            setCreating(true)
          }}
        >
          <Archive size={14} />
        </IconButton>
      }
    >
      {creating ? <StashForm onClose={() => setCreating(false)} /> : null}

      {stashes.isPending ? (
        <p className="flex items-center gap-1.5 px-2.5 py-2 text-xs text-ink-faint">
          <Loader size={11} className="animate-spin" />
          {t('git.stash.loading')}
        </p>
      ) : null}

      {stashes.error ? (
        <div className="p-2">
          <Banner>{stashes.error instanceof Error ? stashes.error.message : t('git.action.failed')}</Banner>
        </div>
      ) : null}

      {stashes.data && list.length === 0 ? (
        <p className="px-2.5 py-2 text-xs text-ink-faint">{t('git.stash.empty')}</p>
      ) : null}

      {list.map((stash) => {
        const name = `stash@{${stash.index}}`
        return (
          <div
            key={`${stash.index}-${stash.ts}`}
            className="group/stash flex items-center gap-0.5 border-b border-line/60 pr-1 hover:bg-surface-high"
          >
            <div className="flex h-8 min-w-0 flex-1 items-center gap-1.5 pl-2.5">
              <span className="shrink-0 font-mono text-[0.625rem] text-ink-faint">{name}</span>
              <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-ink-soft" title={stash.message}>
                {stash.message}
              </span>
              {stash.branch ? (
                <span className="hidden shrink-0 text-[0.625rem] text-ink-faint @min-[26rem]:inline">
                  {t('git.stash.on', { branch: stash.branch })}
                </span>
              ) : null}
              <span className="shrink-0 text-[0.625rem] text-ink-faint">{relativeDate(stash.ts)}</span>
            </div>
            <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/stash:opacity-100 focus-within:opacity-100 has-[[data-state=open]]:opacity-100 pointer-coarse:opacity-100">
              <IconButton
                label={t('git.stash.pop')}
                size="sm"
                disabled={busy}
                onClick={() => pop.mutate({ index: stash.index }, { onSuccess: report, onError })}
              >
                <ArchiveRestore size={14} />
              </IconButton>
              <Menu
                trigger={
                  <IconButton label={t('git.stash.actions', { name })} size="sm" disabled={busy}>
                    <Ellipsis size={15} />
                  </IconButton>
                }
              >
                <MenuItem
                  icon={<Undo2 size={14} />}
                  onSelect={() => apply.mutate({ index: stash.index }, { onSuccess: report, onError })}
                >
                  {t('git.stash.apply')}
                </MenuItem>
                <MenuItem
                  icon={<ArchiveRestore size={14} />}
                  onSelect={() => pop.mutate({ index: stash.index }, { onSuccess: report, onError })}
                >
                  {t('git.stash.pop')}
                </MenuItem>
                <MenuSeparator />
                <MenuItem icon={<Trash2 size={14} />} tone="critical" onSelect={() => setDropping(stash)}>
                  {t('git.stash.drop')}
                </MenuItem>
              </Menu>
            </div>
          </div>
        )
      })}

      <ConfirmDialog
        open={dropping !== null}
        onOpenChange={(value) => {
          if (!value) setDropping(null)
        }}
        title={t('git.stash.drop.title', { name: dropping ? `stash@{${dropping.index}}` : '' })}
        confirmLabel={t('git.stash.drop')}
        tone="critical"
        busy={drop.isPending}
        onConfirm={() =>
          dropping &&
          drop.mutate({ index: dropping.index }, { onError, onSettled: () => setDropping(null) })
        }
      >
        <p>{dropping?.message}</p>
        <p>{t('git.stash.drop.body')}</p>
      </ConfirmDialog>
    </Section>
  )
}

function StashForm({ onClose }: { onClose: () => void }) {
  const t = useTranslate()
  const { scope, notify } = useGitPane()
  const push = useGitAction<{ message?: string; includeUntracked: boolean }, GitActionDto>(scope, 'stash')
  const [message, setMessage] = useState('')
  const [includeUntracked, setIncludeUntracked] = useState(true)

  const submit = () =>
    push.mutate(
      { message: message.trim() || undefined, includeUntracked },
      {
        onSuccess: (result) => {
          notify({ tone: 'positive', text: result.summary ?? t('git.notice.done') })
          onClose()
        },
        onError: (error) => notify(failureNotice(error, t('git.action.failed'))),
      },
    )

  return (
    <form
      className="flex flex-col gap-2 border-b border-line/60 bg-sunken/40 p-2"
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <input
        autoFocus
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        placeholder={t('git.stash.message')}
        aria-label={t('git.stash.message')}
        className="h-8 w-full rounded-md border border-line bg-surface px-2 text-[0.8125rem] text-ink outline-none placeholder:text-ink-faint focus:border-accent"
      />
      <label className="flex items-center gap-1.5 text-xs text-ink-soft">
        <input
          type="checkbox"
          checked={includeUntracked}
          onChange={(event) => setIncludeUntracked(event.target.checked)}
          className="accent-[var(--sg-accent)]"
        />
        {t('git.stash.includeUntracked')}
      </label>
      <div className="flex justify-end gap-1">
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          {t('dialog.cancel')}
        </Button>
        <Button type="submit" size="sm" disabled={push.isPending}>
          {push.isPending ? t('git.stash.pending') : t('git.stash.submit')}
        </Button>
      </div>
    </form>
  )
}
