import type { ProjectDto } from '@sillage/protocol'
import { CalendarClock, Palette, Pencil, SlidersHorizontal, SquareKanban } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { useTranslate } from '../../lib/i18n'
import { PROJECT_COLORS } from '../../lib/project-colors'
import { useUpdateProject } from '../../lib/projects'
import { ContextMenuItem, ContextMenuSeparator, ContextMenuSwatch, MenuItem, MenuLabel, MenuSeparator, MenuSwatch, MenuSwatchRow } from '../ui'

/** Project actions shared by ellipsis button and heading context menu. */
export function ProjectMenuItems({
  variant,
  project,
  onRename,
  onNavigate,
}: {
  variant: 'context' | 'dropdown'
  project: ProjectDto
  onRename: () => void
  onNavigate: () => void
}) {
  const t = useTranslate()
  const navigate = useNavigate()
  const updateProject = useUpdateProject()
  const Item = variant === 'context' ? ContextMenuItem : MenuItem
  const Separator = variant === 'context' ? ContextMenuSeparator : MenuSeparator
  const Swatch = variant === 'context' ? ContextMenuSwatch : MenuSwatch
  const go = (path: string) => {
    onNavigate()
    navigate(path)
  }

  return (
    <>
      <Item icon={<Pencil size={14} />} onSelect={onRename}>
        {t('shell.rename')}
      </Item>
      <Item icon={<SquareKanban size={14} />} onSelect={() => go(`/p/${project.id}/board`)}>
        {t('shell.project.board')}
      </Item>
      <Item icon={<CalendarClock size={14} />} onSelect={() => go(`/p/${project.id}/schedules`)}>
        {t('schedule.title')}
      </Item>
      <Item icon={<SlidersHorizontal size={14} />} onSelect={() => go(`/p/${project.id}`)}>
        {t('shell.project.settings')}
      </Item>
      <Separator />
      {/* Labels and rows are plain blocks shared by both primitives. */}
      <MenuLabel>
        <span className="flex items-center gap-1.5">
          <Palette size={11} /> {t('shell.color')}
        </span>
      </MenuLabel>
      <MenuSwatchRow>
        {PROJECT_COLORS.map((entry) => (
          <Swatch
            key={entry.value ?? 'default'}
            color={entry.value}
            label={t(entry.label)}
            selected={project.color === entry.value}
            onSelect={() => updateProject.mutate({ id: project.id, color: entry.value })}
          />
        ))}
      </MenuSwatchRow>
    </>
  )
}
