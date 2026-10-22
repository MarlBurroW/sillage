import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import {
  SEARCH_MARK_CLOSE,
  SEARCH_MARK_OPEN,
  SEARCH_MIN_QUERY,
  type SearchMessageDto,
} from '@sillage/protocol'
import { api } from './api'

/** Typical typing delay: shorter waits query the server needlessly for every letter. */
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
 * Search message content. `keepPreviousData` avoids emptying and refilling the list on each
 * keystroke, flashing despite valid existing results. `settling` indicates the query has not yet
 * been sent so users know more results will arrive after debounce.
 */
export function useMessageSearch(query: string) {
  const settled = useDebounced(query)

  const result = useQuery({
    queryKey: ['search', settled],
    queryFn: () => api.get<SearchMessageDto[]>(`/api/search?q=${encodeURIComponent(settled)}`),
    enabled: settled.trim().length >= SEARCH_MIN_QUERY,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  })
  return {
    data: result.data,
    isFetching: result.isFetching,
    settling: settled !== query && query.trim().length >= SEARCH_MIN_QUERY,
  }
}

export interface ExcerptPart {
  text: string
  /** Whether this fragment is one of the matches. */
  hit: boolean
}

/**
 * Split an excerpt at SQLite-provided boundaries. Matches use two control characters rather than
 * markup: rendering remains text and never injects database HTML.
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
 * Subsequence score between query and text: cmpct finds compaction. Return null if letters are
 * absent or out of order. Consecutive letters and word starts score higher so scattered matches do
 * not outrank literal ones.
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

  // For equal scores prefer shorter titles, where the query covers more of the text.
  return score - haystack.length / 100
}
