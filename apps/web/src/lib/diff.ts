/**
 * Découpage d'un diff unifié.
 *
 * Écrit ici plutôt qu'ajouté en dépendance : le format est celui que `git diff`
 * produit, il tient en une centaine de lignes, et les bibliothèques du domaine font
 * surtout l'inverse (calculer un diff, ce que git fait déjà pour nous).
 */

export interface DiffLine {
  kind: 'added' | 'removed' | 'context' | 'meta'
  text: string
  /** Numéro dans le fichier d'avant, absent sur une ligne ajoutée. */
  before: number | null
  /** Numéro dans le fichier d'après, absent sur une ligne supprimée. */
  after: number | null
}

export interface DiffHunk {
  /** L'en-tête `@@ ... @@`, qui porte aussi le nom de la fonction englobante. */
  header: string
  lines: DiffLine[]
}

export interface DiffFile {
  path: string
  /** Chemin d'origine quand le fichier a été déplacé. */
  oldPath: string | null
  status: 'added' | 'removed' | 'renamed' | 'modified' | 'binary'
  hunks: DiffHunk[]
  added: number
  removed: number
}

/** `@@ -12,7 +12,9 @@ contexte` : les deux positions de départ nous suffisent. */
const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/**
 * Chemin d'un `diff --git a/x b/y`.
 *
 * Les deux moitiés sont séparées par ` b/`, et non par un espace : un nom de fichier
 * peut contenir des espaces, et git ne les échappe pas dans cette ligne.
 */
function parseHeaderPaths(line: string): { from: string; to: string } | null {
  const body = line.slice('diff --git '.length)
  const at = body.indexOf(' b/')
  if (at === -1) return null
  return { from: body.slice(2, at), to: body.slice(at + 3) }
}

export function parseUnifiedDiff(patch: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | null = null
  let hunk: DiffHunk | null = null
  let before = 0
  let after = 0

  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const paths = parseHeaderPaths(line)
      file = {
        path: paths?.to ?? '',
        oldPath: null,
        status: 'modified',
        hunks: [],
        added: 0,
        removed: 0,
      }
      hunk = null
      files.push(file)
      continue
    }

    if (!file) continue

    if (line.startsWith('new file mode')) {
      file.status = 'added'
      continue
    }
    if (line.startsWith('deleted file mode')) {
      file.status = 'removed'
      continue
    }
    if (line.startsWith('rename from ')) {
      file.oldPath = line.slice('rename from '.length)
      file.status = 'renamed'
      continue
    }
    if (line.startsWith('Binary files ')) {
      file.status = 'binary'
      continue
    }

    const bounds = HUNK.exec(line)
    if (bounds) {
      before = Number(bounds[1])
      after = Number(bounds[2])
      hunk = { header: line, lines: [] }
      file.hunks.push(hunk)
      continue
    }

    if (!hunk) continue

    if (line.startsWith('+')) {
      file.added += 1
      hunk.lines.push({ kind: 'added', text: line.slice(1), before: null, after })
      after += 1
    } else if (line.startsWith('-')) {
      file.removed += 1
      hunk.lines.push({ kind: 'removed', text: line.slice(1), before, after: null })
      before += 1
    } else if (line.startsWith('\\')) {
      // « \ No newline at end of file » : une note sur la ligne précédente, pas une ligne.
      hunk.lines.push({ kind: 'meta', text: line.slice(2), before: null, after: null })
    } else {
      hunk.lines.push({ kind: 'context', text: line.slice(1), before, after })
      before += 1
      after += 1
    }
  }

  return files
}
