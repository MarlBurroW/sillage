import type { ProjectDto } from '@sillage/protocol'
import { cx } from './ui'

/**
 * Project marker uses an image or fallback color dot in identical boxes so names stay aligned
 * across mixed lists.
 */
export function ProjectAvatar({
  project,
  className = 'size-4',
}: {
  project: Pick<ProjectDto, 'image' | 'color'> | undefined
  /** Box size. */
  className?: string
}) {
  if (project?.image) {
    return (
      <img
        src={project.image.url}
        alt=""
        // Contain rather than cover: cropped logos become unrecognizable.
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
