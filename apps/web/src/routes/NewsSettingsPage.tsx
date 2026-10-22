import { useRef, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ChevronLeft, ChevronRight, ExternalLink, Plus, Rss, Search, Trash2 } from 'lucide-react'
import { NEWS_SUGGESTIONS, type NewsPreferences } from '@sillage/protocol'
import { Banner, Button, Card, CardBody, Field, IconButton, Switch, cx } from '../components/ui'
import { SectionHeader } from './SettingsPage'
import { useNews, useNewsBrowser, usePreviewFeed, useUpdateNews } from '../lib/news'
import { useUserSettings } from '../lib/user-settings'
import { locale, translateError, useTranslate } from '../lib/i18n'

export function NewsSettingsPage() {
  const t = useTranslate()
  const [params] = useSearchParams()
  const section = params.get('section') === 'sources' ? 'sources' : 'articles'
  const { data: settings, error } = useUserSettings()
  const { data: news, error: newsError } = useNews()
  const update = useUpdateNews()
  const preview = usePreviewFeed()
  const [adding, setAdding] = useState(false)
  const [url, setUrl] = useState('')
  const [testedUrl, setTestedUrl] = useState('')
  const addButton = useRef<HTMLDivElement>(null)
  const prefs = settings?.news
  const articles = useNewsBrowser(news?.articles ?? [], (article) => `${article.title} ${article.source}`, 10)
  const sources = useNewsBrowser(prefs?.sources ?? [], (source) => `${source.url} ${news?.sources.find((entry) => entry.url === source.url)?.title ?? ''}`, 6)
  const search = (value: 'articles' | 'sources') => {
    const next = new URLSearchParams(params)
    next.set('section', value)
    return `?${next}`
  }
  const save = (next: NewsPreferences) => update.mutate(next)
  const test = (event: FormEvent) => {
    event.preventDefault()
    setTestedUrl(url.trim())
    preview.mutate(url.trim())
  }
  const closeForm = () => {
    setAdding(false)
    setUrl('')
    preview.reset()
    requestAnimationFrame(() => addButton.current?.querySelector('button')?.focus())
  }
  const duplicate = prefs?.sources.some((source) => source.url === url.trim())
  const add = () => {
    if (!prefs || !preview.data || url.trim() !== testedUrl || duplicate || prefs.sources.length >= 20 || update.isPending) return
    // Keep the preview and URL on failure so a retry never requires entering the feed again.
    update.mutate({ ...prefs, sources: [...prefs.sources, { url: testedUrl, enabled: true }] }, {
      onSuccess: () => { sources.search(''); sources.setPage(Math.floor(prefs.sources.length / 6)); closeForm() },
    })
  }

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="shrink-0">
        <SectionHeader title={t('news.title')} />
        {(error || newsError || update.error) ? <Banner tone="critical">{(error || newsError || update.error)?.message}</Banner> : null}
        {prefs ? <div className="mb-2 flex items-center justify-between gap-3">
          <span className="text-sm font-medium text-ink">{t('news.enabled')}</span>
          <Switch label={t('news.enabled')} checked={prefs.enabled} disabled={update.isPending} onCheckedChange={(enabled) => save({ ...prefs, enabled })} />
        </div> : null}
        <nav aria-label={t('news.navigation')} className="grid grid-cols-2 border-b border-line">
          {(['articles', 'sources'] as const).map((value) => <Link key={value} to={{ search: search(value) }} aria-current={section === value ? 'page' : undefined}
            className={cx('flex min-h-11 items-center justify-center border-b-2 text-sm font-medium', section === value ? 'border-accent text-accent' : 'border-transparent text-ink-faint hover:text-ink')}>
            {t(value === 'articles' ? 'news.recent' : 'news.sources')}
          </Link>)}
        </nav>
      </div>
      {prefs ? <>
        <section aria-label={t('news.recent')} hidden={section !== 'articles'} className={cx('flex min-h-0 flex-1 flex-col', section !== 'articles' && 'hidden')}>
          <div className="shrink-0 space-y-3 py-3">
            <SearchInput label={t('news.search.articles')} value={articles.query} onChange={articles.search} />
            <Pages browser={articles} />
          </div>
          <div key={`${articles.page}:${articles.query}`} className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-news-articles>
            <NewsHelp />
            {!news?.articles.length ? <p className="text-sm text-ink-muted">{t(prefs.enabled ? 'news.noArticles' : 'news.disabledHint')}</p>
              : articles.count === 0 ? <p role="status" className="text-sm text-ink-muted">{t('news.search.empty')}</p> : null}
            <ul className="divide-y divide-line">{articles.items.map((article) => <li key={article.url} className="py-3">
              <a className="text-sm text-ink-soft hover:text-accent" href={article.url} target="_blank" rel="noopener noreferrer">{article.title} <ExternalLink size={12} className="inline" /></a>
              <p className="mt-1 text-xs text-ink-faint">{article.source}{article.publishedAt !== null ? ` · ${new Date(article.publishedAt).toLocaleDateString(locale())}` : ''}</p>
            </li>)}</ul>
          </div>
        </section>
        <section aria-label={t('news.sources')} hidden={section !== 'sources'} className={cx('flex min-h-0 flex-1 flex-col', section !== 'sources' && 'hidden')}>
          <div ref={addButton} className="flex shrink-0 items-center justify-between gap-2 py-3">
            <p className="text-xs text-ink-faint">{t('news.sourceCount', { count: prefs.sources.length })}</p>
            <Button size="sm" variant="secondary" icon={<Plus size={14} />} disabled={adding || prefs.sources.length >= 20} onClick={() => setAdding(true)}>{t('news.addSource')}</Button>
          </div>
          {adding ? <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-3">
            <Card><CardBody>
              <form onSubmit={test} className="flex flex-col gap-3">
                <Field autoFocus label={t('news.add')} type="url" placeholder="https://example.com/feed.xml" value={url} onChange={(event) => { setUrl(event.target.value); preview.reset() }} required />
                <p className="text-xs text-ink-muted">{t('news.addHint')}</p>
                <div className="flex flex-wrap gap-2">
                  {NEWS_SUGGESTIONS.filter((suggestion) => !prefs.sources.some((source) => source.url === suggestion.url)).map((suggestion) => <Button key={suggestion.url} type="button" size="sm" variant="ghost" onClick={() => { setUrl(suggestion.url); preview.reset() }}><Plus size={13} />{suggestion.name}</Button>)}
                </div>
                {preview.error ? <Banner tone="critical">{preview.error.message}</Banner> : null}
                {duplicate ? <p className="text-xs text-ink-muted">{t('news.duplicate')}</p> : null}
                <div className="flex flex-wrap gap-2">
                  <Button type="submit" size="sm" disabled={!url.trim() || preview.isPending || duplicate || prefs.sources.length >= 20}>{t(preview.isPending ? 'news.testing' : 'news.test')}</Button>
                  <Button type="button" size="sm" variant="ghost" disabled={update.isPending} onClick={closeForm}>{t('common.cancel')}</Button>
                </div>
              </form>
              {preview.data && testedUrl === url.trim() ? <div className="mt-4 border-t border-line pt-3" data-news-preview>
                <p className="text-sm font-medium">{preview.data.title}</p>
                <ul className="my-2 space-y-1 text-xs text-ink-muted">{preview.data.articles.slice(0, 3).map((article) => <li key={article.url}>{article.title}</li>)}</ul>
                {!preview.data.articles.length ? <p className="my-2 text-xs text-ink-muted">{t('news.emptyFeed')}</p> : null}
                <Button size="sm" disabled={update.isPending || duplicate || prefs.sources.length >= 20} onClick={add}>{t('news.addSource')}</Button>
              </div> : null}
            </CardBody></Card>
          </div> : <>
            {prefs.sources.length > 0 ? <div className="shrink-0 space-y-3 pb-3">
              <SearchInput label={t('news.search.sources')} value={sources.query} onChange={sources.search} />
              <Pages browser={sources} />
            </div> : null}
            <div key={`${sources.page}:${sources.query}`} className="min-h-0 flex-1 overflow-y-auto overscroll-contain" data-news-sources>
              <NewsHelp />
              <div className="divide-y divide-line">
                {sources.items.map((source) => {
                  const status = news?.sources.find((entry) => entry.url === source.url)
                  return <div key={source.url} className="flex items-start gap-2 py-3">
                    <Rss size={15} className="mt-2 shrink-0 text-ink-faint" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-ink">{status?.title ?? new URL(source.url).hostname}</p>
                      <p className="break-all text-xs text-ink-muted">{source.url}</p>
                      {status?.error ? <p className="mt-1 text-xs text-ink-muted">{translateError(status.error, t('news.feedError'))}</p> : null}
                      {status?.checkedAt ? <p className="mt-1 text-xs text-ink-faint">{t('news.checked', { date: new Date(status.checkedAt).toLocaleString(locale(), { dateStyle: 'short', timeStyle: 'short' }) })}</p> : null}
                    </div>
                    <Switch checked={source.enabled} label={t('news.sourceEnabled', { source: status?.title ?? source.url })} disabled={update.isPending} onCheckedChange={(enabled) => save({ ...prefs, sources: prefs.sources.map((entry) => entry.url === source.url ? { ...entry, enabled } : entry) })} />
                    <IconButton label={t('news.remove', { source: status?.title ?? source.url })} disabled={update.isPending} onClick={() => save({ ...prefs, sources: prefs.sources.filter((entry) => entry.url !== source.url) })}><Trash2 size={15} /></IconButton>
                  </div>
                })}
              </div>
              {!prefs.sources.length ? <p className="text-sm text-ink-muted">{t('news.noSources')}</p> : sources.count === 0 ? <p role="status" className="text-sm text-ink-muted">{t('news.search.empty')}</p> : null}
            </div>
          </>}
        </section>
      </> : null}
    </div>
  )
}

function Pages({ browser }: { browser: { page: number; pages: number; count: number; setPage: (page: number) => void } }) {
  const t = useTranslate()
  return <div className="flex items-center justify-between gap-1">
    <p role="status" className="text-xs text-ink-faint">{t('news.page', { page: browser.page + 1, pages: browser.pages, count: browser.count })}</p>
    {browser.pages > 1 ? <div className="flex gap-1">
      <IconButton size="sm" label={t('news.previous')} disabled={browser.page === 0} onClick={() => browser.setPage(browser.page - 1)}><ChevronLeft size={16} /></IconButton>
      <IconButton size="sm" label={t('news.nextPage')} disabled={browser.page === browser.pages - 1} onClick={() => browser.setPage(browser.page + 1)}><ChevronRight size={16} /></IconButton>
    </div> : null}
  </div>
}

function SearchInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <div className="flex h-11 items-center gap-2 rounded-md border border-line bg-sunken px-3 focus-within:border-accent">
    <Search size={15} className="shrink-0 text-ink-faint" />
    <input type="search" aria-label={label} placeholder={label} value={value} onChange={(event) => onChange(event.target.value)}
      className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-faint" />
  </div>
}

function NewsHelp() {
  const t = useTranslate()
  return <details className="mb-2 text-xs text-ink-faint">
    <summary className="cursor-pointer py-2 text-ink-soft">{t('news.help')}</summary>
    <div className="space-y-2 pb-2"><p>{t('news.description')}</p><p>{t('news.recentHint')}</p><p>{t('news.rotation')}</p></div>
  </details>
}
