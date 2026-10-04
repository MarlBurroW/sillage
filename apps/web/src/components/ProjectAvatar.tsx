import type { ProjectDto } from '@sillage/protocol'
import { cx } from './ui'

/**
 * Le repère visuel d'un projet : son image, ou à défaut sa pastille de couleur.
 *
 * Les deux occupent la même boîte, pour que les noms restent alignés dans une liste où
 * certains projets ont une image et d'autres non.
 */
export function ProjectAvatar({
  project,
  className = 'size-4',
}: {
  project: Pick<ProjectDto, 'image' | 'color'> | undefined
  /** Taille de la boîte. */
  className?: string
}) {
  if (project?.image) {
    return (
      <img
        src={project.image.url}
        alt=""
        // `contain` et non `cover` : un logo rogné ne se reconnaît plus.
        className={cx('shrink-0 rounded-[22%] object-contain', className)}
      />
    )
  }

  return (
    <span aria-hidden className={cx('flex shrink-0 items-center justify-center', className)}>
      <span
        className="size-1/2 rounded-full"
        style={{ background: project?.color ?? 'var(--sg-accent)' }}
      />
    </span>
  )
}
