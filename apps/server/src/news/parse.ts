import { XMLParser, XMLValidator } from 'fast-xml-parser'
import type { NewsArticle, NewsFeed } from '@sillage/protocol'
import { FeedError } from './fetch.js'

type Node = Record<string, unknown>
const node = (value: unknown): Node => value && typeof value === 'object' && !Array.isArray(value) ? value as Node : {}
const list = (value: unknown): unknown[] => value === undefined ? [] : Array.isArray(value) ? value : [value]
function text(value: unknown): string {
  const raw = typeof value === 'string' ? value : node(value)['#text']
  return typeof raw === 'string' ? raw.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim().slice(0, 500) : ''
}
function articleUrl(value: string, base: string): string | null {
  try {
    const url = new URL(value, base)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null
    url.hash = ''
    for (const key of [...url.searchParams.keys()]) if (/^utm_|^(fbclid|gclid)$/.test(key)) url.searchParams.delete(key)
    return url.href
  } catch { return null }
}

export function parseFeed(xml: string, base: string): NewsFeed {
  // Feeds need neither DTDs nor author-defined entities.
  if (/<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new FeedError('news_parse')
  const parsed = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, parseAttributeValue: false }).parse(xml) as Node
  const atom = parsed.feed !== undefined
  const channel = node(atom ? parsed.feed : node(parsed.rss).channel ?? parsed.RDF)
  if (!Object.keys(channel).length) throw new FeedError('news_parse')
  const title = text(channel.title) || new URL(base).hostname
  const entries = list(atom ? channel.entry : channel.item ?? node(parsed.RDF).item)
  const seen = new Set<string>()
  const articles: NewsArticle[] = []
  for (const raw of entries.slice(0, 200)) {
    const item = node(raw)
    const link = atom
      ? list(item.link).map(node).find((l) => !l['@_rel'] || l['@_rel'] === 'alternate')?.['@_href']
      : item.link
    const url = articleUrl(typeof link === 'string' ? link : text(link), base)
    const headline = text(item.title)
    if (!link || !url || !headline || seen.has(url)) continue
    const date = Date.parse(text(item.pubDate ?? item.published ?? item.updated ?? item.date))
    seen.add(url)
    articles.push({ title: headline, url, source: title, publishedAt: Number.isFinite(date) ? date : null })
  }
  return { title, articles }
}
