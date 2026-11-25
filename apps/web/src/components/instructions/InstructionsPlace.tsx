import type { InstructionsMode } from '@sillage/protocol'
import { FileCode, FileText } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useTranslate, type MessageKey, type MessageParams } from '../../lib/i18n'
import {
  useGlobalInstructions,
  useInstructionsPlace,
  useProjectInstructions,
  useUpdateProjectInstructions,
  type InstructionsPlace,
} from '../../lib/instructions'
import { Logo } from '../Logo'
import { ChoiceList, ConfirmDialog, IconButton, cx, type Choice } from '../ui'

/**
 * Where instructions live, recognisable before reading: the Sillage mark for database rows, a code
 * file for the repository's own file. Same shape everywhere it appears, so the mode is learnt once.
 */
export function InstructionsPlaceIcon({ mode, size = 14, className }: { mode: InstructionsMode; size?: number; className?: string }) {
  return mode === 'sillage' ? <Logo size={size} className={className} /> : <FileCode size={size} className={className} />
}

/** Icon for a project's current place; the plain document while it loads, as before modes showed. */
export function ProjectInstructionsIcon({ projectId, size = 14, className }: { projectId: string; size?: number; className?: string }) {
  const place = useInstructionsPlace(projectId)
  return place ? <InstructionsPlaceIcon mode={place.mode} size={size} className={className} /> : <FileText size={size} className={className} />
}

/** Toolbar button showing, before any click, where an added instruction would go. */
export function InstructionsButton({ projectId, onOpen }: { projectId: string; onOpen: () => void }) {
  const t = useTranslate()
  const place = useInstructionsPlace(projectId)
  return (
    <IconButton label={place ? t('conversation.instructions.place', { place: instructionsPlaceLabel(t, place) }) : t('conversation.instructions')} onClick={onOpen}>
      <ProjectInstructionsIcon projectId={projectId} size={18} />
    </IconButton>
  )
}

/** Names the repository file: the mode is only clear once one knows which file the agents read. */
export function instructionsPlaceLabel(t: (key: MessageKey, params?: MessageParams) => string, place: InstructionsPlace) {
  return place.mode === 'sillage' ? t('instructions.place.sillage') : t('instructions.place.repo', { file: place.file })
}

/**
 * Both layers an agent receives, one row each, with where each is kept. In the dialog the rows also
 * pick which layer is edited below; on the project page the global row leads to its settings.
 */
export function InstructionsSummary({ projectId, selected, onSelect }: {
  projectId: string
  selected: 'project' | 'global'
  /** Absent where only the project layer is edited: the global row then links to its settings. */
  onSelect?: (layer: 'project' | 'global') => void
}) {
  const t = useTranslate()
  const { data: project } = useProjectInstructions(projectId)
  const { data: global } = useGlobalInstructions()
  const place = useInstructionsPlace(projectId)
  const [changing, setChanging] = useState(false)

  return (
    <div className="flex flex-col divide-y divide-line rounded-md border border-line text-sm">
      <SummaryRow
        layer={t('instructions.tab.project')}
        current={selected === 'project'}
        onSelect={onSelect ? () => onSelect('project') : undefined}
        place={place ? <><InstructionsPlaceIcon mode={place.mode} className="shrink-0" /><span className="truncate">{instructionsPlaceLabel(t, place)}</span></> : null}
        aside={project?.canEdit ? <button type="button" onClick={() => setChanging(true)} className="text-xs text-accent hover:underline">{t('instructions.place.change')}</button> : null}
      />
      <SummaryRow
        layer={t('instructions.tab.global')}
        current={selected === 'global'}
        onSelect={onSelect ? () => onSelect('global') : undefined}
        // Global instructions have no other home than Sillage.
        place={<><InstructionsPlaceIcon mode="sillage" className="shrink-0" /><span className="truncate">{t('instructions.place.sillage')}</span></>}
        aside={onSelect
          ? global && !global.canEdit ? <span className="text-xs text-ink-faint">{t('instructions.place.adminOnly')}</span> : null
          : <Link to="/settings/consignes" className="text-xs text-accent hover:underline">{t('instructions.place.open')}</Link>}
      />
      {project ? <ModeDialog projectId={projectId} open={changing} onOpenChange={setChanging} mode={project.mode} /> : null}
    </div>
  )
}

// On phones the layer name sits above its place, so neither gets cut.
const rowContent = 'flex min-w-0 flex-1 flex-col items-start justify-center gap-0.5 py-2 pl-3 sm:flex-row sm:items-center sm:justify-start sm:gap-3 sm:py-0'

function SummaryRow({ layer, place, aside, current, onSelect }: {
  layer: string
  place: ReactNode
  aside: ReactNode
  current: boolean
  onSelect?: () => void
}) {
  const content = <>
    <span className={cx('shrink-0 text-xs sm:w-32', current && onSelect ? 'font-medium text-ink' : 'text-ink-faint')}>{layer}</span>
    <span className="flex max-w-full min-w-0 items-center gap-2 text-ink-soft">{place}</span>
  </>
  // Left edge marks the edited layer, square as the interface's other edge markers.
  return (
    <div className={cx('flex min-h-11 items-center gap-3 border-l-2 pr-3', current && onSelect ? 'border-accent bg-accent-wash/40' : 'border-transparent')}>
      {onSelect
        ? <button type="button" aria-pressed={current} onClick={onSelect} className={cx(rowContent, 'self-stretch text-left hover:text-ink')}>{content}</button>
        : <div className={rowContent}>{content}</div>}
      {aside}
    </div>
  )
}

/** Changing the place changes what agents receive: a dialog explains both before applying. */
function ModeDialog({ projectId, open, onOpenChange, mode }: {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  mode: InstructionsMode
}) {
  const t = useTranslate()
  const update = useUpdateProjectInstructions(projectId)
  const [chosen, setChosen] = useState<InstructionsMode | null>(null)
  const value = chosen ?? mode
  const options: Choice<InstructionsMode>[] = [
    { value: 'sillage', label: t('instructions.mode.sillage'), hint: t('instructions.mode.sillage.hint'), icon: <InstructionsPlaceIcon mode="sillage" /> },
    { value: 'repo', label: t('instructions.mode.repo'), hint: t('instructions.mode.repo.hint'), icon: <InstructionsPlaceIcon mode="repo" /> },
  ]
  const close = (next: boolean) => { onOpenChange(next); if (!next) setChosen(null) }
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={close}
      title={t('instructions.place.changeTitle')}
      confirmLabel={t('instructions.place.apply')}
      confirmDisabled={value === mode}
      busy={update.isPending}
      onConfirm={() => update.mutate({ mode: value }, { onSuccess: () => close(false) })}
    >
      <ChoiceList label={t('instructions.mode')} value={value} options={options} onChange={setChosen} wrapHints />
      <p className="text-xs text-ink-faint">{t('instructions.dialog.timing')}</p>
    </ConfirmDialog>
  )
}
