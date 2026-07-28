import { useEffect } from 'react'

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
