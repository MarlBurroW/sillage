import { ChevronRight, Pause, Play, Rss, X } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { IconButton } from '../ui'
import { useNews, useNewsRotation } from '../../lib/news'
import { useUserSettings } from '../../lib/user-settings'
import { locale, useTranslate } from '../../lib/i18n'

export function NewsTicker() {
  const t = useTranslate()
  const { data: settings } = useUserSettings()
  const [hidden, setHidden] = useState(false)
  const [paused, setPaused] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const enabled = settings?.news.enabled === true && !hidden
  const { data } = useNews(enabled)
  const articles = data?.articles ?? []
  const { index, next } = useNewsRotation(articles, !enabled || paused || hovered || focused)
  const article = articles[index]
  if (!enabled || !article) return null
  return (
    <aside aria-label={t('news.title')} data-news-ticker
      onPointerEnter={(e) => { if (e.pointerType === 'mouse') setHovered(true) }} onPointerLeave={(e) => { if (e.pointerType === 'mouse') setHovered(false) }}
      onFocus={(e) => setFocused(e.target.matches(':focus-visible'))} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false) }}
      className="my-2 flex min-w-0 items-start gap-2 border-l-2 border-line-strong py-1 pl-3 text-xs">
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex flex-wrap items-center gap-x-2 text-ink-faint">
          <Link to="/settings/veille" className="inline-flex items-center gap-1 hover:text-ink"><Rss size={12} />{t('news.title')}</Link>
          <span>{article.source}</span>
          {article.publishedAt !== null && <time dateTime={new Date(article.publishedAt).toISOString()}>{new Date(article.publishedAt).toLocaleDateString(locale(), { day: 'numeric', month: 'short' })}</time>}
        </div>
        <a key={article.url} href={article.url} target="_blank" rel="noopener noreferrer" data-news-headline
          className="news-headline line-clamp-2 min-h-8 break-words font-medium leading-4 text-ink-soft hover:text-accent focus-visible:outline-2 focus-visible:outline-accent">
          {article.title}
        </a>
      </div>
      <div className="flex shrink-0 items-center">
        <IconButton size="sm" label={t(paused ? 'news.resume' : 'news.pause')} onClick={() => setPaused(!paused)}>{paused ? <Play size={14} /> : <Pause size={14} />}</IconButton>
        <IconButton size="sm" label={t('news.next')} disabled={articles.length < 2} onClick={next}><ChevronRight size={16} /></IconButton>
        <IconButton size="sm" label={t('news.hide')} onClick={() => setHidden(true)}><X size={14} /></IconButton>
      </div>
    </aside>
  )
}
