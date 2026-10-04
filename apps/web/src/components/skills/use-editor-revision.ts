import { useEffect, useRef, useState } from 'react'

/**
 * Révision d'un `CodeEditor` dont le texte peut changer ailleurs.
 *
 * L'éditeur ne lit son contenu qu'au montage : c'est ce qui préserve le curseur et
 * l'historique de qui tape. Mais quand le texte change côté serveur (une mise à jour
 * appliquée depuis la source, par exemple), il montrerait encore l'ancien, et un Ctrl+S
 * le réécrirait par-dessus la nouvelle version. On le remonte donc quand le texte du
 * serveur diffère de ce qu'il affiche, et seulement sans brouillon : des modifications
 * en cours ne sont jamais remplacées sous les doigts.
 */
export function useEditorRevision(serverText: string | null, hasDraft: boolean) {
  /** Ce que l'éditeur affiche : le texte du montage, puis chaque frappe. */
  const shown = useRef(serverText)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    if (serverText === null || hasDraft || serverText === shown.current) return
    // Le premier texte reçu est celui du montage : rien à remonter.
    const loaded = shown.current !== null
    shown.current = serverText
    if (loaded) setRevision((value) => value + 1)
  }, [serverText, hasDraft])

  return {
    revision,
    /** À appeler à chaque frappe. */
    track: (text: string) => {
      shown.current = text
    },
    /** Abandonne le brouillon : l'éditeur repart du texte du serveur. */
    reset: () => {
      shown.current = serverText
      setRevision((value) => value + 1)
    },
  }
}
