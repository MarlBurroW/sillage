import type { ProjectDto } from '@sillage/protocol'
import { Check, Minus, Plus } from 'lucide-react'
import { useState } from 'react'
import { useTranslate } from '../../lib/i18n'
import type { RailProjects } from '../../lib/rail-projects'
import { TooltipButton } from '../ui/Tooltip'
import { cx } from '../ui'

/**
 * Adds a project to the rail or takes it off, in words: wherever projects are listed, this is the
 * one control for it, so nobody has to guess which gesture fills the rail.
 */
export function RailToggle({ project, rail }: { project: ProjectDto; rail: RailProjects }) {
  const t = useTranslate()
  const kept = rail.isKept(project.id)
  // Kept reachable rather than disabled: its tooltip says why the last project stays.
  const locked = kept && !rail.canRemove
  // A click that adds must be answered by "in the rail", not by the offer to undo it under the
  // same pointer: the swap waits until the pointer has left once.
  const [settled, setSettled] = useState(true)
  const swaps = kept && !locked && settled
  return (
    <TooltipButton
      type="button"
      data-rail-toggle={project.id}
      aria-pressed={kept}
      aria-disabled={locked || undefined}
      aria-label={t(kept ? 'shell.rail.toggle.removeNamed' : 'shell.rail.toggle.addNamed', { name: project.name })}
      title={locked ? t('shell.rail.toggle.last') : undefined}
      // The visible words already say it: a tooltip would repeat the button.
      tooltipDisabled={locked ? undefined : true}
      onClick={() => { if (!locked) { setSettled(false); rail.setKept(project, !kept) } }}
      onPointerLeave={() => setSettled(true)}
      className={cx(
        'group/toggle inline-grid h-7 shrink-0 items-center rounded-md px-2 text-xs font-medium whitespace-nowrap transition-colors pointer-coarse:h-9',
        'outline-none focus-visible:ring-2 focus-visible:ring-accent',
        kept ? 'text-ink-faint' : 'bg-accent-wash text-accent hover:bg-accent hover:text-accent-ink',
        swaps && 'hover:bg-critical/12 hover:text-critical',
        locked && 'cursor-default',
      )}
    >
      {kept ? (
        // Both labels share one cell, so the button keeps its width when hover swaps them.
        <>
          <span className={cx('col-start-1 row-start-1 inline-flex items-center justify-center gap-1', swaps && 'group-hover/toggle:invisible')}><Check size={13} className="text-accent" />{t('shell.rail.toggle.kept')}</span>
          <span aria-hidden className={cx('invisible col-start-1 row-start-1 inline-flex items-center justify-center gap-1', swaps && 'group-hover/toggle:visible')}><Minus size={13} />{t('shell.rail.toggle.remove')}</span>
        </>
      ) : (
        <span className="inline-flex items-center justify-center gap-1"><Plus size={13} />{t('shell.rail.toggle.add')}</span>
      )}
    </TooltipButton>
  )
}
