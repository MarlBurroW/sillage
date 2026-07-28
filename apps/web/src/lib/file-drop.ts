import { useCallback, useEffect, useState, type DragEvent } from 'react'
import { dropInComposer } from './composer-ref'

/**
 * Dépôt de fichiers sur la conversation.
 *
 * Le navigateur ouvre par défaut le fichier déposé, en remplaçant la page ou dans un
 * nouvel onglet : déposer une capture d'écran sur le fil quittait donc l'application au
 * lieu de joindre l'image. La zone de dépôt annule ce comportement, et un garde posé sur
 * la fenêtre l'annule aussi partout ailleurs, sans quoi rater la zone de quelques pixels
 * suffirait à perdre la conversation.
 */

/** Vrai si le glissement transporte des fichiers, et non du texte ou un lien. */
function carriesFiles(transfer: DataTransfer | null): boolean {
  return transfer !== null && Array.from(transfer.types).includes('Files')
}

/**
 * Empêche la fenêtre d'ouvrir un fichier déposé à côté de la zone prévue.
 *
 * Monté une fois par application. Ne touche pas aux glissements sans fichier, dont le
 * navigateur fait quelque chose d'utile, comme déplacer du texte dans un champ.
 */
export function useFileDropGuard(): void {
  useEffect(() => {
    const swallow = (event: globalThis.DragEvent) => {
      if (carriesFiles(event.dataTransfer)) event.preventDefault()
    }
    window.addEventListener('dragover', swallow)
    window.addEventListener('drop', swallow)
    return () => {
      window.removeEventListener('dragover', swallow)
      window.removeEventListener('drop', swallow)
    }
  }, [])
}

/**
 * Attributs à poser sur la zone qui accepte les fichiers, et son état de survol.
 *
 * `dragging` compte les entrées et les sorties plutôt que de basculer un booléen :
 * survoler un enfant émet un `dragleave` sur le parent, et un simple booléen ferait
 * clignoter le cadre à chaque bulle traversée.
 */
export function useFileDrop(enabled: boolean) {
  const [depth, setDepth] = useState(0)

  useEffect(() => {
    if (!enabled) setDepth(0)
  }, [enabled])

  const onDragEnter = useCallback(
    (event: DragEvent) => {
      if (!enabled || !carriesFiles(event.dataTransfer)) return
      event.preventDefault()
      setDepth((count) => count + 1)
    },
    [enabled],
  )

  const onDragOver = useCallback(
    (event: DragEvent) => {
      if (!enabled || !carriesFiles(event.dataTransfer)) return
      // Sans ce `preventDefault` sur le survol, le navigateur refuse le dépôt et
      // retombe sur son comportement par défaut.
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    },
    [enabled],
  )

  const onDragLeave = useCallback((event: DragEvent) => {
    if (!carriesFiles(event.dataTransfer)) return
    setDepth((count) => Math.max(0, count - 1))
  }, [])

  const onDrop = useCallback(
    (event: DragEvent) => {
      if (!enabled || !carriesFiles(event.dataTransfer)) return
      event.preventDefault()
      setDepth(0)

      const files = Array.from(event.dataTransfer.files)
      if (files.length > 0) dropInComposer(files)
    },
    [enabled],
  )

  return {
    dragging: depth > 0,
    handlers: { onDragEnter, onDragOver, onDragLeave, onDrop },
  }
}
