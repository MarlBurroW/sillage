import type { WorktreePullRequest as PullRequest } from '@sillage/protocol'
import { useTranslate } from '../lib/i18n'

export function WorktreePullRequest({ pull }: { pull: PullRequest | null | undefined }) {
  const t = useTranslate()
  if (!pull) return null
  return <p className="mt-1 wrap-anywhere text-xs text-ink-soft">
    <a href={pull.url} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-accent">
      {t('worktrees.pr.link', { number: pull.number })}
    </a>
    {' · '}{t(`worktrees.pr.${pull.state}`)}
    {pull.checks && <> · {t(`worktrees.pr.checks.${pull.checks}`)}</>}
  </p>
}
