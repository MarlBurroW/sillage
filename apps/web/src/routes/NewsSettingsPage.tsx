import { useState, type FormEvent } from 'react'
import { ExternalLink, Plus, Rss, Trash2 } from 'lucide-react'
import { NEWS_SUGGESTIONS, type NewsPreferences } from '@sillage/protocol'
import { Banner, Button, Card, CardBody, Field, IconButton, Switch } from '../components/ui'
import { SectionHeader } from './SettingsPage'
import { useNews, usePreviewFeed, useUpdateNews } from '../lib/news'
import { useUserSettings } from '../lib/user-settings'
import { locale, translateError, useTranslate } from '../lib/i18n'

export function NewsSettingsPage() {
  const t = useTranslate()
  const { data: settings, error } = useUserSettings()
  const { data: news } = useNews()
  const update = useUpdateNews()
  const preview = usePreviewFeed()
  const [url, setUrl] = useState('')
  const [testedUrl, setTestedUrl] = useState('')
  const prefs = settings?.news
  const save = (next: NewsPreferences) => update.mutate(next)
  const test = (e: FormEvent) => { e.preventDefault(); setTestedUrl(url.trim()); preview.mutate(url.trim()) }
  const add = () => {
    if (!prefs || !preview.data || url.trim() !== testedUrl) return
    save({ ...prefs, sources: [...prefs.sources, { url: testedUrl, enabled: true }] })
    setUrl(''); preview.reset()
  }
  const duplicate = prefs?.sources.some((s) => s.url === url.trim())
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <SectionHeader title={t('news.title')} description={t('news.description')} />
      {(error || update.error) && <Banner tone="critical">{(error || update.error)?.message}</Banner>}
      {prefs && <>
        <Card><CardBody>
          <div className="flex items-center justify-between gap-4">
            <div><h2 className="text-sm font-medium text-ink">{t('news.enabled')}</h2><p className="mt-1 text-xs text-ink-muted">{t('news.rotation')}</p></div>
            <Switch label={t('news.enabled')} checked={prefs.enabled} disabled={update.isPending} onCheckedChange={(enabled) => save({ ...prefs, enabled })} />
          </div>
        </CardBody></Card>
        <section aria-label={t('news.sources')}>
          <h2 className="mb-2 text-sm font-semibold text-ink">{t('news.sources')}</h2>
          <div className="divide-y divide-line">
            {prefs.sources.map((source) => {
              const status = news?.sources.find((s) => s.url === source.url)
              return <div key={source.url} className="flex items-start gap-2 py-3">
                <Rss size={15} className="mt-2 shrink-0 text-ink-faint" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-ink">{status?.title ?? new URL(source.url).hostname}</p>
                  <p className="break-all text-xs text-ink-muted">{source.url}</p>
                  {status?.error && <p className="mt-1 text-xs text-ink-muted">{translateError(status.error, t('news.feedError'))}</p>}
                  {status?.checkedAt && <p className="mt-1 text-xs text-ink-faint">{t('news.checked', { date: new Date(status.checkedAt).toLocaleString(locale(), { dateStyle: 'short', timeStyle: 'short' }) })}</p>}
                </div>
                <Switch checked={source.enabled} label={t('news.sourceEnabled', { source: status?.title ?? source.url })} disabled={update.isPending} onCheckedChange={(enabled) => save({ ...prefs, sources: prefs.sources.map((s) => s.url === source.url ? { ...s, enabled } : s) })} />
                <IconButton label={t('news.remove', { source: status?.title ?? source.url })} disabled={update.isPending} onClick={() => save({ ...prefs, sources: prefs.sources.filter((s) => s.url !== source.url) })}><Trash2 size={15} /></IconButton>
              </div>
            })}
          </div>
          {!prefs.sources.length && <p className="text-sm text-ink-muted">{t('news.noSources')}</p>}
        </section>
        <Card><CardBody>
          <form onSubmit={test} className="flex flex-col gap-3">
            <Field label={t('news.add')} type="url" placeholder="https://example.com/feed.xml" value={url} onChange={(e) => { setUrl(e.target.value); preview.reset() }} required />
            <p className="text-xs text-ink-muted">{t('news.addHint')}</p>
            <div className="flex flex-wrap gap-2">
              {NEWS_SUGGESTIONS.filter((s) => !prefs.sources.some((p) => p.url === s.url)).map((s) => <Button key={s.url} type="button" size="sm" variant="ghost" onClick={() => { setUrl(s.url); preview.reset() }}><Plus size={13} />{s.name}</Button>)}
            </div>
            {preview.error && <Banner tone="critical">{preview.error.message}</Banner>}
            {duplicate && <p className="text-xs text-ink-muted">{t('news.duplicate')}</p>}
            <div><Button type="submit" size="sm" disabled={!url.trim() || preview.isPending || duplicate || prefs.sources.length >= 20}>{t(preview.isPending ? 'news.testing' : 'news.test')}</Button></div>
          </form>
          {preview.data && testedUrl === url.trim() && <div className="mt-4 border-t border-line pt-3" data-news-preview>
            <p className="text-sm font-medium">{preview.data.title}</p>
            <ul className="my-2 space-y-1 text-xs text-ink-muted">{preview.data.articles.slice(0, 3).map((a) => <li key={a.url}>{a.title}</li>)}</ul>
            {!preview.data.articles.length && <p className="my-2 text-xs text-ink-muted">{t('news.emptyFeed')}</p>}
            <Button size="sm" disabled={update.isPending || duplicate || prefs.sources.length >= 20} onClick={add}>{t('news.addSource')}</Button>
          </div>}
        </CardBody></Card>
        <section aria-label={t('news.recent')}>
          <h2 className="mb-2 text-sm font-semibold text-ink">{t('news.recent')}</h2>
          <p className="mb-3 text-xs text-ink-muted">{t('news.recentHint')}</p>
          {!news?.articles.length && <p className="text-sm text-ink-muted">{t(prefs.enabled ? 'news.noArticles' : 'news.disabledHint')}</p>}
          <ul className="divide-y divide-line">{news?.articles.map((a) => <li key={a.url} className="py-3">
            <a className="text-sm text-ink-soft hover:text-accent" href={a.url} target="_blank" rel="noopener noreferrer">{a.title} <ExternalLink size={12} className="inline" /></a>
            <p className="mt-1 text-xs text-ink-faint">{a.source}{a.publishedAt !== null ? ` · ${new Date(a.publishedAt).toLocaleDateString(locale())}` : ''}</p>
          </li>)}</ul>
        </section>
      </>}
    </div>
  )
}
