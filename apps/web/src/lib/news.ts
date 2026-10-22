import { useCallback, useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { foldForMatch, type NewsArticle, type NewsDto, type NewsFeed, type NewsPreferences, type UserSettingsDto } from '@sillage/protocol'
import { api } from './api'

export function useNews(enabled = true) {
  return useQuery({
    queryKey: ['news'],
    queryFn: () => api.get<NewsDto>('/api/news'),
    enabled,
    refetchInterval: (query) => query.state.data?.sources.some((s) => s.checkedAt === null) ? 5000 : 60000,
  })
}
export function useUpdateNews() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (prefs: NewsPreferences) => api.put<UserSettingsDto>('/api/me/news', prefs),
    onSuccess: (settings) => {
      client.setQueryData(['user-settings'], settings)
      void client.invalidateQueries({ queryKey: ['news'] })
    },
  })
}
export function usePreviewFeed() {
  return useMutation({ mutationFn: (url: string) => api.post<NewsFeed>('/api/news/preview', { url }) })
}

/** Rotation belongs to reading: no network access per headline or turn. */
export function useNewsRotation(articles: NewsArticle[], paused: boolean) {
  const [selected, setSelected] = useState<string | null>(null)
  // A cache refresh must not replace the link under the pointer.
  useEffect(() => {
    if (articles.length && !articles.some((article) => article.url === selected)) setSelected(articles[0]!.url)
  }, [articles, selected])
  const next = useCallback(() => {
    if (!articles.length) return
    setSelected((current) => {
      const index = Math.max(0, articles.findIndex((article) => article.url === current))
      return articles[(index + 1) % articles.length]!.url
    })
  }, [articles])
  useEffect(() => {
    if (paused || articles.length < 2) return
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') next()
    }, 12000)
    return () => window.clearInterval(timer)
  }, [articles.length, paused, next])
  return { index: Math.max(0, articles.findIndex((article) => article.url === selected)), next }
}

/** Stable, bounded browsing of feeds or articles, including matches outside the current page. */
export function useNewsBrowser<T>(items: T[], describe: (item: T) => string, pageSize: number) {
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(0)
  const matches = useMemo(() => {
    const terms = foldForMatch(query).trim().split(/\s+/).filter(Boolean)
    return items.filter((item) => {
      const text = foldForMatch(describe(item))
      return terms.every((term) => text.includes(term))
    })
  }, [items, describe, query])
  const pages = Math.max(1, Math.ceil(matches.length / pageSize))
  const current = Math.min(page, pages - 1)
  return {
    query, search: (value: string) => { setQuery(value); setPage(0) },
    page: current, pages, setPage, count: matches.length,
    items: matches.slice(current * pageSize, (current + 1) * pageSize),
  }
}
