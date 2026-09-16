import { useCallback, useSyncExternalStore } from 'react'

export interface CardDraft {
  title: string
  description: string
}

export interface CardNoteDraft {
  body: string
}

/** Un magasin par saisie ; cartes et notes ne s’effacent pas entre elles. */
function createDraftStore<T>(prefix: string, valid: (value: unknown) => value is T) {
  const drafts = new Map<string, T | null>()
  const listeners = new Set<() => void>()

  function read(key: string): T | null {
    if (!drafts.has(key)) {
      let draft: T | null = null
      try {
        const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? 'null')
        if (valid(value)) draft = value
      } catch { /* Le brouillon reste en mémoire si le stockage est indisponible. */ }
      drafts.set(key, draft)
    }
    return drafts.get(key) ?? null
  }

  function write(key: string, draft: T | null): void {
    drafts.set(key, draft)
    try {
      if (draft) sessionStorage.setItem(key, JSON.stringify(draft))
      else sessionStorage.removeItem(key)
    } catch { /* La fermeture du panneau reste sans perte dans cet onglet. */ }
    for (const notify of listeners) notify()
  }

  function subscribe(notify: () => void) {
    listeners.add(notify)
    return () => { listeners.delete(notify) }
  }

  return function useStoredDraft(userId: string, cardId: string) {
    const key = `${prefix}:${userId}:${cardId}`
    const draft = useSyncExternalStore(subscribe, () => read(key), () => null)
    const acknowledge = useCallback((submitted: T) => {
      // Une réponse lente ne doit pas effacer une saisie plus récente, même après
      // fermeture puis réouverture de la carte pendant la requête.
      if (read(key) === submitted) write(key, null)
    }, [key])
    return { draft, setDraft: (next: T | null) => write(key, next), acknowledge }
  }
}

export const useCardDraft = createDraftStore<CardDraft>('sillage.cardDraft', (value): value is CardDraft =>
  typeof value === 'object' && value !== null && 'title' in value && 'description' in value &&
  typeof value.title === 'string' && typeof value.description === 'string',
)

export const useCardNoteDraft = createDraftStore<CardNoteDraft>('sillage.cardNoteDraft', (value): value is CardNoteDraft =>
  typeof value === 'object' && value !== null && 'body' in value && typeof value.body === 'string',
)
