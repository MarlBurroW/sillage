import { PanelEmptyState } from './PanelEmptyState'
import { TooltipButton } from '../ui/Tooltip'
import { Loader, Plus, SquareTerminal as TerminalIcon, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { MAX_TERMINALS_PER_PROJECT, type TerminalDto } from '@sillage/protocol'
import { useTranslate } from '../../lib/i18n'
import { clearFocusedTerminal, useFocusedTerminal } from '../../lib/panel'
import { useProjects } from '../../lib/projects'
import { useCloseTerminal, useOpenTerminal, useTerminals } from '../../lib/terminals'
import { Banner, Button, cx } from '../ui'
import { TerminalView } from './TerminalView'

/**
 * Terminal tabs above the active terminal. Lists belong to projects and are shared across
 * session/project views; each tab names its shell directory. Only new-terminal cwd depends on
 * current context. Keep every view mounted so switching neither interrupts commands nor clears
 * screens while PTYs continue.
 */
export function TerminalsPane({
  projectId,
  /** Present in conversation views to open terminals in their cwd. */
  conversationId,
  visible,
}: {
  projectId: string
  conversationId?: string
  visible: boolean
}) {
  const { data: terminals, error, isPending } = useTerminals(projectId, visible)
  const { data: projects } = useProjects()
  const open = useOpenTerminal(projectId)
  const close = useCloseTerminal(projectId)
  const [active, setActive] = useState<string | null>(null)
  const t = useTranslate()

  const workspacePath = projects?.find((project) => project.id === projectId)?.workspacePath

  // Selection follows the list: closed terminals must not leave views targeting nothing.
  useEffect(() => {
    if (!terminals) return
    setActive((current) =>
      current && terminals.some((terminal) => terminal.id === current)
        ? current
        : (terminals[0]?.id ?? null),
    )
  }, [terminals])

  // Bring action-opened terminals forward as soon as refetched lists contain them.
  const focused = useFocusedTerminal()
  useEffect(() => {
    if (!focused || !terminals?.some((terminal) => terminal.id === focused)) return
    setActive(focused)
    clearFocusedTerminal()
  }, [focused, terminals])

  const full = (terminals?.length ?? 0) >= MAX_TERMINALS_PER_PROJECT
  const openNew = (input?: { cwd?: string }) =>
    open.mutate(input?.cwd ? input : { conversationId }, {
      onSuccess: (created) => setActive(created.id),
    })

  /** Shell location: workspace or worktree directory name. */
  const dirLabel = (terminal: TerminalDto) =>
    terminal.cwd === workspacePath
      ? t('terminal.dir.workspace')
      : (terminal.cwd.split('/').pop() ?? terminal.cwd)

  const activeTerminal = terminals?.find((terminal) => terminal.id === active)

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex shrink-0 items-center gap-px overflow-x-auto border-b border-line">
        {(terminals ?? []).map((terminal) => (
          <div
            key={terminal.id}
            className={cx(
              'group/term flex h-8 shrink-0 items-center gap-1 border-r border-line pr-1 pl-2.5',
              terminal.id === active ? 'bg-surface text-ink' : 'bg-sunken text-ink-faint',
            )}
          >
            <button
              type="button"
              onClick={() => setActive(terminal.id)}
              title={terminal.cwd}
              className="flex items-baseline gap-1.5 text-xs"
            >
              {terminal.title}
              <span className="text-[0.625rem] text-ink-faint">{dirLabel(terminal)}</span>
            </button>
            {/* Distinguish running and finished shells so dead tabs do not resemble inactive ones. */}
            <span
              aria-label={terminal.alive ? t('terminal.tab.shellAlive') : t('terminal.tab.shellDone')}
              className={cx(
                'size-1.5 shrink-0 rounded-full',
                // Signal failed action commands without opening their tab.
                terminal.alive ? 'bg-positive' : terminal.exitCode ? 'bg-critical' : 'bg-ink-faint/50',
              )}
            />
            <TooltipButton
              type="button"
              onClick={() => close.mutate(terminal.id)}
              aria-label={t('terminal.tab.close', { title: terminal.title })}
              className="rounded p-0.5 text-ink-faint opacity-0 hover:text-ink group-hover/term:opacity-100"
            >
              <X size={12} />
            </TooltipButton>
          </div>
        ))}

        <TooltipButton
          type="button"
          // Select newly created terminals: clicking plus without visible change would appear ineffective.
          onClick={() => openNew()}
          disabled={full || open.isPending}
          aria-label={t('terminal.new')}
          title={full ? t('terminal.max', { max: MAX_TERMINALS_PER_PROJECT }) : t('terminal.new')}
          className="flex size-8 shrink-0 items-center justify-center text-ink-faint hover:text-ink disabled:opacity-40"
        >
          {open.isPending ? <Loader size={13} className="animate-spin" /> : <Plus size={14} />}
        </TooltipButton>
      </div>

      {error || open.error || close.error ? (
        <div className="p-2">
          <Banner>
            {(error ?? open.error ?? close.error) instanceof Error
              ? (error ?? open.error ?? close.error)?.message
              : t('terminal.unavailable')}
          </Banner>
        </div>
      ) : null}

      {isPending ? (
        <p className="flex items-center gap-1.5 px-2.5 py-2 text-xs text-ink-faint">
          <Loader size={11} className="animate-spin" />
          {t('terminal.loading')}
        </p>
      ) : null}

      {terminals?.length === 0 ? (
        <PanelEmptyState>
          <span className="grid size-12 place-items-center rounded-xl border border-line bg-surface-high text-ink-faint">
            <TerminalIcon size={22} />
          </span>
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium text-ink">{t('terminal.empty.title')}</p>
            <p className="max-w-[22rem] text-xs text-ink-faint">
              {t('terminal.empty.description')}
            </p>
          </div>
          <Button size="sm" disabled={open.isPending} onClick={() => openNew()}>
            {open.isPending ? <Loader size={14} className="animate-spin" /> : <Plus size={14} />}
            {t('terminal.new')}
          </Button>
        </PanelEmptyState>
      ) : null}

      {/* Daemon restart ended the shell: retain its last screen and relaunch a fresh shell in the same directory. */}
      {activeTerminal?.interrupted ? (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-line bg-surface-high px-2.5 py-1.5">
          <p className="text-[0.6875rem] text-ink-faint">{t('terminal.interrupted')}</p>
          <Button
            size="sm"
            disabled={full || open.isPending}
            onClick={() => openNew({ cwd: activeTerminal.cwd })}
          >
            {t('terminal.relaunch')}
          </Button>
        </div>
      ) : null}

      {(terminals ?? []).map((terminal) => (
        <div
          key={terminal.id}
          className={cx(
            'min-h-0 min-w-0 flex-1',
            terminal.id === active && visible ? 'block' : 'hidden',
          )}
        >
          <TerminalView
            projectId={projectId}
            terminalId={terminal.id}
            visible={terminal.id === active && visible}
          />
        </div>
      ))}
    </div>
  )
}
