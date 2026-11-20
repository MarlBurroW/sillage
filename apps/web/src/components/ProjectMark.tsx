import type { ProjectDto } from '@sillage/protocol'
import type { CSSProperties } from 'react'
import { cx } from './ui'

/**
 * A project as the rail shows it: its image, or its initials on its color. Wherever a list leads
 * to the rail it uses this mark, so a project is recognized by the same face.
 */
export function ProjectMark({ project, size, className }: {
  project: Pick<ProjectDto, 'name' | 'image' | 'color'>
  /** Side in pixels; the rail's own size when absent. */
  size?: number
  className?: string
}) {
  const box = size ? { '--mark-size': `${size}px` } as CSSProperties : undefined
  if (project.image) {
    // Contain rather than cover: cropped logos become unrecognizable.
    return <img src={project.image.url} alt="" style={box} className={cx('nav-project-mark object-contain', className)} />
  }
  const initials = project.name.trim().split(/\s+/).slice(0, 2).map((word) => [...word][0] ?? '').join('').toLocaleUpperCase()
  return <span aria-hidden style={{ ...box, '--mark': project.color ?? 'var(--sg-accent)' } as CSSProperties} className={cx('nav-project-mark', className)}>{initials}</span>
}
