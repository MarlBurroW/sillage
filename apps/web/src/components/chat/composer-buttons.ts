import { cx } from '../ui'

/**
 * Boutons de la barre du composer. Au doigt sur ordinateur, 44 px ; à la souris,
 * 32 px. Au téléphone, 36 px à l'œil pour tenir sur une ligne, et une marge invisible
 * qui rend au doigt ses 44 px.
 */
export function toolButtonClass(narrow: boolean): string {
  return cx(
    'flex shrink-0 items-center justify-center rounded-md text-ink-faint transition-colors',
    'hover:bg-surface-high hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
    'data-[state=open]:bg-surface-high data-[state=open]:text-ink disabled:pointer-events-none disabled:opacity-45',
    narrow ? 'relative size-9 before:absolute before:-inset-1 before:content-[""]' : 'size-11 md:size-8 pointer-coarse:size-11',
  )
}
