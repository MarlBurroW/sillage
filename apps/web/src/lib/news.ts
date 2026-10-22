import { useCallback, useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { NewsArticle, NewsDto, NewsFeed, NewsPreferences, UserSettingsDto } from '@sillage/protocol'
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
