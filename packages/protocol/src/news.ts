import { z } from 'zod'

export const newsSourceSchema = z.object({ url: z.string().url().max(2048), enabled: z.boolean() })
export const newsPreferencesSchema = z.object({
  enabled: z.boolean(),
  sources: z.array(newsSourceSchema).max(20),
})
export type NewsPreferences = z.infer<typeof newsPreferencesSchema>
export const NEWS_SUGGESTIONS = [
  { name: 'Hugging Face', url: 'https://huggingface.co/blog/feed.xml' },
  { name: 'Google DeepMind', url: 'https://deepmind.google/blog/rss.xml' },
  { name: 'OpenAI', url: 'https://openai.com/news/rss.xml' },
] as const
export const DEFAULT_NEWS_PREFERENCES: NewsPreferences = {
  enabled: false,
  sources: NEWS_SUGGESTIONS.map(({ url }) => ({ url, enabled: true })),
}
export interface NewsArticle {
  title: string
  url: string
  source: string
  publishedAt: number | null
}
export interface NewsFeed {
  title: string
  articles: NewsArticle[]
}
export interface NewsSourceStatus {
  url: string
  title: string
  checkedAt: number | null
  error: string | null
}
export interface NewsDto {
  articles: NewsArticle[]
  sources: NewsSourceStatus[]
}
