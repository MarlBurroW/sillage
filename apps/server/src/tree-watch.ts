import { watch, type FSWatcher } from 'node:fs'

/**
 * Veille sur les dossiers que l'explorateur affiche.
 *
 * Non récursive, et seulement sur les niveaux dépliés : une veille récursive sur un
 * répertoire de travail poserait une veille inotify par sous-dossier, `node_modules`
 * compris, et épuiserait le quota de la machine sur un seul dépôt. Le client déclare
 * ce qu'il regarde, ce qui borne le coût à ce qui est réellement à l'écran.
 *
 * Les veilles sont partagées par chemin absolu et comptées : deux onglets ouverts sur
 * le même worktree, ou deux conversations qui le partagent, n'en posent qu'une.
 */

/**
 * Une écriture émet plusieurs événements, et une commande comme `npm install` en émet
 * des milliers. Ce délai les regroupe en une seule relecture du niveau.
 */
const DEBOUNCE_MS = 250

interface Shared {
  watcher: FSWatcher
  listeners: Set<() => void>
  timer: NodeJS.Timeout | null
}

const shared = new Map<string, Shared>()

function fire(absolute: string): void {
  const entry = shared.get(absolute)
  if (!entry) return
  entry.timer = null
  for (const listener of entry.listeners) listener()
}

/**
 * Suit un dossier et rend de quoi cesser de le suivre.
 *
 * Un dossier absent ou illisible rend une veille inerte plutôt qu'une erreur : le
 * client peut demander un niveau qui vient d'être supprimé, et c'est la veille de son
 * parent qui le lui apprendra.
 */
export function watchDirectory(absolute: string, onChange: () => void): () => void {
  let entry = shared.get(absolute)

  if (!entry) {
    let watcher: FSWatcher
    try {
      watcher = watch(absolute, { persistent: false })
    } catch {
      return () => {}
    }

    const created: Shared = { watcher, listeners: new Set(), timer: null }
    shared.set(absolute, created)
    entry = created

    watcher.on('change', () => {
      if (created.timer) return
      created.timer = setTimeout(() => fire(absolute), DEBOUNCE_MS)
      created.timer.unref()
    })

    // Dossier supprimé, ou limite d'inotify atteinte : la veille est morte et ne
    // reviendra pas. Les abonnés sont prévenus une dernière fois, ce qui leur fait
    // relire le niveau et découvrir sa disparition.
    watcher.on('error', () => {
      watcher.close()
      shared.delete(absolute)
      for (const listener of created.listeners) listener()
    })
  }

  const held = entry
  held.listeners.add(onChange)

  return () => {
    held.listeners.delete(onChange)
    if (held.listeners.size > 0) return

    if (held.timer) clearTimeout(held.timer)
    held.watcher.close()
    // La veille en cours a pu être remplacée entre-temps après une erreur : ne retirer
    // que celle qu'on tient.
    if (shared.get(absolute) === held) shared.delete(absolute)
  }
}
