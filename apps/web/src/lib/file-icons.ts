import {
  fileExtensions,
  fileNames,
  folderNames,
  folderNamesExpanded,
} from 'material-icon-theme/dist/material-icons.json'

/**
 * Icône d'une entrée de l'explorateur, d'après le jeu d'icônes de VS Code.
 *
 * La correspondance vient de la bibliothèque, pas d'une table écrite ici : elle couvre
 * 1378 extensions, 2131 noms de fichiers exacts (`package.json`, `Dockerfile`,
 * `.gitignore`) et 4654 noms de dossiers. Seuls ces trois index sont importés, les
 * autres clés du fichier étant écartées par le bundler.
 *
 * Les SVG sont servis en statique (`public/file-icons`, rempli par `pnpm icons:sync`)
 * plutôt qu'inclus dans le paquet : 240 Ko compressés pour des icônes dont on affiche
 * une poignée à la fois.
 */

const ICON_BASE = '/file-icons'

/** Repli du jeu d'icônes lui-même, pas une invention : ce sont ses noms génériques. */
const DEFAULT_FILE = 'file'
const DEFAULT_FOLDER = 'folder'
const DEFAULT_FOLDER_OPEN = 'folder-open'

const byExtension = fileExtensions as Record<string, string>
const byName = fileNames as Record<string, string>
const byFolder = folderNames as Record<string, string>
const byFolderOpen = folderNamesExpanded as Record<string, string>

/**
 * Extensions successives, de la plus longue à la plus courte.
 *
 * `component.test.tsx` doit être reconnu comme un test avant d'être reconnu comme du
 * TypeScript : la bibliothèque indexe les deux formes, la plus spécifique gagne.
 */
function extensionsOf(name: string): string[] {
  const parts = name.toLowerCase().split('.')
  return parts.slice(1).map((_, index) => parts.slice(index + 1).join('.'))
}

function iconName(name: string, isDirectory: boolean, open: boolean): string {
  const lower = name.toLowerCase()

  if (isDirectory) {
    // La variante ouverte a son propre index dans la bibliothèque : la déduire par
    // suffixe donnerait un nom d'icône inexistant pour les dossiers sans variante.
    const folder = open ? byFolderOpen[lower] : byFolder[lower]
    return folder ?? (open ? DEFAULT_FOLDER_OPEN : DEFAULT_FOLDER)
  }

  const exact = byName[lower]
  if (exact) return exact

  for (const extension of extensionsOf(lower)) {
    const found = byExtension[extension]
    if (found) return found
  }
  return DEFAULT_FILE
}

export function fileIconUrl(name: string, isDirectory: boolean, open = false): string {
  return `${ICON_BASE}/${iconName(name, isDirectory, open)}.svg`
}
