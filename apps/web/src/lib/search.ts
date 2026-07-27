import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import {
  SEARCH_MARK_CLOSE,
  SEARCH_MARK_OPEN,
  SEARCH_MIN_QUERY,
  type SearchMessageDto,
} from '@sillage/protocol'
import { api } from './api'

/** Frappe moyenne : en dessous, on interroge le serveur à chaque lettre pour rien. */
const DEBOUNCE_MS = 200

export function useDebounced<T>(value: T, delay = DEBOUNCE_MS): T {
  const [settled, setSettled] = useState(value)

  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay)
    return () => clearTimeout(timer)
  }, [value, delay])

  return settled
}

/**
 * Recherche dans le contenu des messages.
 *
 * `keepPreviousData` : sans lui, chaque frappe vide la liste avant de la remplir, et la
 * section clignote alors qu'elle affichait déjà une réponse valable.
 */
export function useMessageSearch(query: string) {
  const settled = useDebounced(query)

  return useQuery({
    queryKey: ['search', settled],
    queryFn: () => api.get<SearchMessageDto[]>(`/api/search?q=${encodeURIComponent(settled)}`),
    enabled: settled.trim().length >= SEARCH_MIN_QUERY,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })
}

export interface ExcerptPart {
  text: string
  /** Vrai si ce fragment est l'une des correspondances trouvées. */
  hit: boolean
}

/**
 * Découpe un extrait sur les bornes posées par SQLite.
 *
 * Les correspondances arrivent encadrées par deux caractères de contrôle plutôt que
 * par du balisage : le rendu reste du texte, sans jamais injecter de HTML venu de la
 * base.
 */
export function splitExcerpt(excerpt: string): ExcerptPart[] {
  const parts: ExcerptPart[] = []
  let rest = excerpt

  for (;;) {
    const open = rest.indexOf(SEARCH_MARK_OPEN)
    const close = open === -1 ? -1 : rest.indexOf(SEARCH_MARK_CLOSE, open)
    if (open === -1 || close === -1) break

    if (open > 0) parts.push({ text: rest.slice(0, open), hit: false })
    parts.push({ text: rest.slice(open + 1, close), hit: true })
    rest = rest.slice(close + 1)
  }

  if (rest) parts.push({ text: rest, hit: false })
  return parts
}

/**
 * Score d'une saisie contre un texte, par sous-séquence : « cmpct » retrouve
 * « compaction ». Renvoie null quand les lettres n'y sont pas dans l'ordre.
 *
 * Les lettres consécutives et les débuts de mot valent plus : sans ça, un titre qui
 * porte la frappe éparpillée passe devant celui qui la porte telle quelle.
 */
export function scoreMatch(text: string, query: string): number | null {
  const haystack = text.toLowerCase()
  const needle = query.toLowerCase()

  let score = 0
  let at = 0

  for (const letter of needle) {
    const found = haystack.indexOf(letter, at)
    if (found === -1) return null

    if (found === at) score += 3
    else if (found === 0 || ' -_/.'.includes(haystack[found - 1] ?? '')) score += 2
    else score += 1

    at = found + 1
  }

  // À score égal, le titre le plus court est le plus probable : la frappe y occupe
  // une part plus grande de ce qui est écrit.
  return score - haystack.length / 100
}
