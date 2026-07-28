import { statSync } from 'node:fs'
import type { EditDiffDto } from '@sillage/protocol'
import { additionDiff, unifiedDiff } from '../../diff-lines.js'

/**
 * Modifications de fichiers déduites des appels d'outils de Claude Code.
 *
 * Le SDK déclare bien un hook `FileChanged` (chemin + `add`/`change`/`unlink`), qui
 * serait la source idéale puisqu'il vient du CLI lui-même. Sondé sur 0.3.220 avec le
 * `watchPaths` que `SessionStart` permet de renvoyer : il ne tire jamais, y compris
 * sur des fichiers écrits dans le cwd annoncé par le CLI. On reste donc sur les
 * outils, avec la limite que ça implique : une écriture faite par `Bash`
 * (`echo > f`, `sed -i`) ne produit aucune modification ici. L'état courant du panneau,
 * lui, la voit, puisqu'il vient de git.
 */

/** Outils qui écrivent, et le champ où chacun déclare son chemin. */
const PATH_FIELDS: Record<string, string> = {
  Write: 'file_path',
  Edit: 'file_path',
  NotebookEdit: 'notebook_path',
}

/**
 * Ce que l'appel a fait du fichier, reconstitué depuis son payload natif.
 *
 * Claude ne transmet pas d'état antérieur : une écriture entière (`Write`) donne le
 * contenu écrit et rien à quoi le comparer, alors qu'une édition ponctuelle (`Edit`)
 * porte l'extrait remplacé et le remplaçant, dont un diff se calcule vraiment. La
 * distinction est affichée telle quelle plutôt que maquillée en diff complet.
 */
export function describeEdit(
  startedRaw: unknown,
  path: string,
  action: 'created' | 'modified' | 'deleted',
): EditDiffDto {
  const block = startedRaw as { name?: string; input?: Record<string, unknown> } | null
  const input = block?.input

  if (!input) {
    return empty(path, "Le détail de cet appel n'a pas été conservé.")
  }

  if (block?.name === 'Edit') {
    const before = input.old_string
    const after = input.new_string
    if (typeof before === 'string' && typeof after === 'string') {
      return {
        path,
        kind: 'patch',
        patch: unifiedDiff(path, before, after),
        content: '',
        partial: true,
        reason: null,
      }
    }
  }

  const written = input.content ?? input.new_source
  if (typeof written === 'string') {
    // Une création n'a pas d'avant : tout est ajouté, et le diff est alors complet.
    if (action === 'created') {
      return { path, kind: 'patch', patch: additionDiff(path, written), content: '', partial: false, reason: null }
    }
    return {
      path,
      kind: 'content',
      patch: '',
      content: written,
      partial: false,
      reason: "Le fichier a été réécrit en entier : son état précédent n'est pas dans le journal.",
    }
  }

  return empty(path, "Cet appel ne porte pas le contenu écrit.")
}

function empty(path: string, reason: string): EditDiffDto {
  return { path, kind: 'unavailable', patch: '', content: '', partial: false, reason }
}

export function editedPath(toolName: string, input: unknown): string | null {
  const field = PATH_FIELDS[toolName]
  if (!field || typeof input !== 'object' || input === null) return null

  const value = (input as Record<string, unknown>)[field]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Vrai si le fichier existe déjà.
 *
 * Observé au **début** de l'appel, seul moment où la réponse distingue une création
 * d'une réécriture : une fois l'outil passé, le fichier existe dans les deux cas.
 * Lire le message de retour du CLI (« File created successfully ») marcherait aussi,
 * mais reviendrait à coder en dur une phrase anglaise qu'il peut reformuler.
 *
 * Synchrone, et c'est le point : une lecture différée peut se résoudre après que
 * l'outil a écrit, et répond alors sur un disque déjà modifié. Un `stat` local coûte
 * quelques microsecondes, là où la version asynchrone demandait en plus de garder
 * l'appel en vie le temps de la réponse.
 */
export function fileExists(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
