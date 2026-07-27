import { useCallback, useEffect, useState } from 'react'

/**
 * `navigator.clipboard` est réservé aux contextes sécurisés, comme
 * `crypto.randomUUID`. Sur `http://<ip-locale>`, il est absent : sans repli, tous
 * les boutons de copie seraient morts sur mobile.
 *
 * Le repli passe par `execCommand('copy')`, déprécié mais universellement supporté,
 * et c'est la seule façon de copier hors contexte sécurisé.
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Permission refusée : on tente quand même le repli ci-dessous.
    }
  }

  const staging = document.createElement('textarea')
  staging.value = text
  staging.setAttribute('readonly', '')
  staging.style.position = 'fixed'
  staging.style.opacity = '0'
  document.body.appendChild(staging)

  try {
    staging.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    staging.remove()
  }
}

export type CopyState = 'idle' | 'copied' | 'failed'

/**
 * Copie et retour visuel éphémère, partagés par tous les boutons de copie.
 *
 * Le retour est indispensable : la copie ne produit aucun effet visible par
 * ailleurs, et un échec silencieux passerait pour un bouton mort.
 */
export function useCopy(): { state: CopyState; copy: (text: string) => void } {
  const [state, setState] = useState<CopyState>('idle')

  useEffect(() => {
    if (state === 'idle') return
    const timer = setTimeout(() => setState('idle'), 1500)
    return () => clearTimeout(timer)
  }, [state])

  const copy = useCallback((text: string) => {
    void copyText(text).then((ok) => setState(ok ? 'copied' : 'failed'))
  }, [])

  return { state, copy }
}
