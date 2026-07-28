import type { MessageKey } from './i18n'
/**
 * Palette des couleurs de projet, en hexadécimal parce que le serveur ne stocke que
 * ça (`projects.color`, validé par une regex #rrggbb).
 *
 * Choisies pour rester lisibles sur les trois thèmes : la pastille est un petit
 * aplat, une couleur trop sombre y disparaît sur fond sombre.
 */
/**
 * Les libellés sont des clés de catalogue et non du texte : cette table est un module,
 * donc évaluée une fois à l'import. Y écrire le texte le figerait dans la langue de
 * départ, comme c'était le cas.
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
