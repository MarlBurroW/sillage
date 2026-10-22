import { eq } from 'drizzle-orm'
import { newsFeeds, userSettings, type Db } from '@sillage/db'
import { storedUserSettingsSchema, type NewsDto, type NewsFeed } from '@sillage/protocol'
import { readUserSettings } from '../settings/user-settings.js'
import { downloadFeed, feedUrl, FeedError } from './fetch.js'
import { parseFeed } from './parse.js'

const HOUR = 60 * 60 * 1000
const MAX_AGE = 30 * 24 * HOUR
export class NewsService {
  private pending = new Map<string, Promise<void>>()
  private timer?: ReturnType<typeof setInterval>
  private refreshing = false
  private refreshAgain = false
  private stopped = false
  constructor(private db: Db, private download = downloadFeed, private now = Date.now) {}

  start(): void {
    void this.refreshSubscribed().catch(() => {})
    this.timer = setInterval(() => { void this.refreshSubscribed().catch(() => {}) }, HOUR)
    this.timer.unref()
  }
  async stop(): Promise<void> {
    this.stopped = true
    clearInterval(this.timer)
    await Promise.allSettled(this.pending.values())
  }

  /** Sequential to bound network work even across multiple accounts. */
  async refreshSubscribed(): Promise<void> {
    if (this.refreshing) { this.refreshAgain = true; return }
    this.refreshing = true
    try {
      const urls = new Set<string>()
      for (const row of this.db.select().from(userSettings).all()) {
        let data: unknown
        try { data = JSON.parse(row.data) } catch { continue }
        const { news } = storedUserSettingsSchema.parse(data)
        if (news.enabled) for (const source of news.sources) if (source.enabled) urls.add(source.url)
      }
      for (const url of urls) {
        if (this.stopped) return
        await this.refresh(url).catch(() => {})
      }
      if (this.stopped) return
      // Removed sources must not grow caches indefinitely.
      for (const row of this.db.select().from(newsFeeds).all()) {
        if (!urls.has(row.url) && row.checkedAt < this.now() - MAX_AGE) this.db.delete(newsFeeds).where(eq(newsFeeds.url, row.url)).run()
      }
    } finally {
      this.refreshing = false
      if (this.refreshAgain && !this.stopped) {
        this.refreshAgain = false
        await this.refreshSubscribed()
      }
    }
  }

  async refresh(url: string): Promise<void> {
    const active = this.pending.get(url)
    if (active) return active
    const cached = this.db.select().from(newsFeeds).where(eq(newsFeeds.url, url)).get()
    if (cached && cached.checkedAt > this.now() - HOUR) return
    // Feed tests share the periodic collection limit.
    if (this.pending.size >= 4) throw new FeedError('news_busy')
    const job = (async () => {
      let data = cached?.data ?? JSON.stringify({ title: new URL(url).hostname, articles: [] })
      let error: string | null = null
      try {
        const result = await this.download(url)
        data = JSON.stringify({ ...parseFeed(result.xml, result.url), fetchedAt: this.now() })
      } catch (err) { error = err instanceof FeedError ? err.code : 'news_fetch' }
      const values = { url, data, checkedAt: this.now(), error }
      this.db.insert(newsFeeds).values(values).onConflictDoUpdate({ target: newsFeeds.url, set: values }).run()
    })()
    this.pending.set(url, job)
    try { await job } finally { this.pending.delete(url) }
  }

  async preview(value: string): Promise<NewsFeed> {
    const url = feedUrl(value).href
    await this.refresh(url)
    const row = this.db.select().from(newsFeeds).where(eq(newsFeeds.url, url)).get()!
    if (row.error) throw new FeedError(row.error)
    return JSON.parse(row.data) as NewsFeed
  }

  read(userId: string): NewsDto {
    const { news } = readUserSettings(this.db, userId)
    const articles: NewsDto['articles'] = []
    const sources: NewsDto['sources'] = []
    for (const source of news.sources) {
      const row = this.db.select().from(newsFeeds).where(eq(newsFeeds.url, source.url)).get()
      const feed = row ? JSON.parse(row.data) as NewsFeed & { fetchedAt?: number } : null
      sources.push({ url: source.url, title: feed?.title ?? new URL(source.url).hostname, checkedAt: row?.checkedAt ?? null, error: row?.error ?? null })
      if (source.enabled && feed) articles.push(...feed.articles.filter((a) => a.publishedAt === null
        ? (feed.fetchedAt ?? 0) >= this.now() - MAX_AGE
        : a.publishedAt >= this.now() - MAX_AGE && a.publishedAt <= this.now() + 24 * HOUR))
    }
    articles.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0))
    const seen = new Set<string>()
    return { sources, articles: articles.filter((a) => { if (seen.has(a.url)) return false; seen.add(a.url); return true }).slice(0, 100) }
  }
}
