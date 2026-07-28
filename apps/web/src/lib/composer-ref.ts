import { useEffect, useRef } from 'react'

/**
 * Chemins envoyés de l'explorateur vers la barre de saisie.
 *
 * Un canal d'événements plutôt qu'un état : il n'y a rien à conserver, seulement un
 * geste à transmettre. Référencer deux fois le même fichier doit d'ailleurs produire
 * deux insertions, ce qu'un état gardant « le dernier chemin » ne saurait pas dire.
 *
 * Hors de React parce que les deux extrémités vivent dans des colonnes différentes de
 * la page : passer par le parent ferait remonter l'état du panneau jusqu'au fil.
 */
type Listener = (path: string) => void

const listeners = new Set<Listener>()

/** Insère `@chemin` dans la barre de saisie de la conversation ouverte. */
export function referenceInComposer(path: string): void {
  for (const listener of listeners) listener(path)
}

export function useComposerReferences(onReference: Listener): void {
  useEffect(() => {
    listeners.add(onReference)
    return () => {
      listeners.delete(onReference)
    }
  }, [onReference])
}

/**
 * Fichiers déposés sur la conversation.
 *
 * Même canal et mêmes raisons que les chemins : le geste part du fil, où la barre de
 * saisie n'est pas, et c'est elle qui sait téléverser. Déposer deux fois le même
 * fichier doit produire deux pièces jointes.
 */
type FileListener = (files: File[]) => void

const fileListeners = new Set<FileListener>()

export function dropInComposer(files: File[]): void {
  for (const listener of fileListeners) listener(files)
}

/**
 * L'abonnement est posé une fois, mais appelle toujours la dernière version reçue :
 * le traitement d'un dépôt lit les pièces jointes déjà présentes, et une fonction
 * capturée au montage en compterait un nombre périmé.
 */
export function useComposerDrops(onDrop: FileListener): void {
  const latest = useRef(onDrop)
  latest.current = onDrop

  useEffect(() => {
    const listener: FileListener = (files) => latest.current(files)
    fileListeners.add(listener)
    return () => {
      fileListeners.delete(listener)
    }
  }, [])
}
