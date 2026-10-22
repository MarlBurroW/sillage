import type { MessageKey } from './i18n'
/**
 * Project color palette in hex because the server stores only that format (`projects.color`,
 * validated by #rrggbb). Keep colors readable on all three themes: small solid dots disappear on
 * dark backgrounds if too dark.
 */
/**
 * Labels are catalog keys rather than text: this module evaluates once at import, so literal
 * translations would freeze the initial language, as previously happened.
 */
export const PROJECT_COLORS: { value: string | null; label: MessageKey }[] = [
  { value: null, label: 'project.color.themeAccent' },
  { value: '#8B7BF7', label: 'project.color.violet' },
  { value: '#5B9DF9', label: 'project.color.blue' },
  { value: '#3FBFC4', label: 'project.color.cyan' },
  { value: '#5BC98C', label: 'project.color.green' },
  { value: '#D9B441', label: 'project.color.amber' },
  { value: '#E8894F', label: 'project.color.orange' },
  { value: '#E5665F', label: 'project.color.red' },
  { value: '#E070A8', label: 'project.color.pink' },
]
