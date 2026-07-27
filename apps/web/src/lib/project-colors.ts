/**
 * Palette des couleurs de projet, en hexadécimal parce que le serveur ne stocke que
 * ça (`projects.color`, validé par une regex #rrggbb).
 *
 * Choisies pour rester lisibles sur les trois thèmes : la pastille est un petit
 * aplat, une couleur trop sombre y disparaît sur fond sombre.
 */
export const PROJECT_COLORS: { value: string | null; label: string }[] = [
  { value: null, label: 'Accent du thème' },
  { value: '#8B7BF7', label: 'Violet' },
  { value: '#5B9DF9', label: 'Bleu' },
  { value: '#3FBFC4', label: 'Cyan' },
  { value: '#5BC98C', label: 'Vert' },
  { value: '#D9B441', label: 'Ambre' },
  { value: '#E8894F', label: 'Orange' },
  { value: '#E5665F', label: 'Rouge' },
  { value: '#E070A8', label: 'Rose' },
]
