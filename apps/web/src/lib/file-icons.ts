import {
  fileExtensions,
  fileNames,
  folderNames,
  folderNamesExpanded,
} from 'material-icon-theme/dist/material-icons.json'

/**
 * Explorer entry icon from VS Code's icon set. Matching comes from the library rather than a local
 * table: 1378 extensions, 2131 exact filenames (`package.json`, `Dockerfile`, `.gitignore`), and
 * 4654 directory names. Import only these three indexes; the bundler removes other keys. Serve SVGs
 * statically (`public/file-icons`, populated by `pnpm icons:sync`) instead of bundling 240 KB
 * compressed for icons shown only a few at a time.
 */

const ICON_BASE = '/file-icons'

/** The icon set's own generic fallback names, not invented ones. */
const DEFAULT_FILE = 'file'
const DEFAULT_FOLDER = 'folder'
const DEFAULT_FOLDER_OPEN = 'folder-open'

const byExtension = fileExtensions as Record<string, string>
const byName = fileNames as Record<string, string>
const byFolder = folderNames as Record<string, string>
const byFolderOpen = folderNamesExpanded as Record<string, string>

/**
 * Successive extensions from longest to shortest. Recognize `component.test.tsx` as a test before
 * TypeScript: the library indexes both and the more specific match wins.
 */
function extensionsOf(name: string): string[] {
  const parts = name.toLowerCase().split('.')
  return parts.slice(1).map((_, index) => parts.slice(index + 1).join('.'))
}

function iconName(name: string, isDirectory: boolean, open: boolean): string {
  const lower = name.toLowerCase()

  if (isDirectory) {
    // Open-folder variants have their own library index: suffix guessing would produce missing
    // icons for folders without variants.
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
