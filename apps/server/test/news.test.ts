import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'
import Fastify from 'fastify'
import { openDatabase, runMigrations, users } from '@sillage/db'
import type { Config } from '../src/config.js'
import { feedUrl, isPublicAddress, downloadFeed } from '../src/news/fetch.js'
import { parseFeed } from '../src/news/parse.js'
import { NewsService } from '../src/news/service.js'
import { readUserSettings, writeNewsPreferences } from '../src/settings/user-settings.js'
import { registerNewsRoutes } from '../src/http/routes/news.js'
import { registerErrorHandler } from '../src/http/errors.js'

const rss = `<rss version="2.0"><channel><title>IA &amp; outils</title><item><title><![CDATA[Un <b>modèle</b> neuf]]></title><link>https://example.org/post?utm_source=rss</link><pubDate>Thu, 22 Oct 2026 00:00:00 GMT</pubDate></item><item><title>Doublon</title><link>https://example.org/post</link></item><item><title>Unsafe</title><link>javascript:alert(1)</link></item></channel></rss>`
function database(t: TestContext) {
  const { db, sqlite } = openDatabase(':memory:')
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))
  t.after(() => sqlite.close())
  for (const id of ['alice', 'bob']) db.insert(users).values({ id, username: id, displayName: id, passwordHash: '', createdAt: 1 }).run()
  return db
}

test('RSS : CDATA, entités, titres en texte, liens sûrs et dédoublonnage', () => {
  const feed = parseFeed(rss, 'https://example.org/feed')
  assert.equal(feed.title, 'IA & outils')
  assert.deepEqual(feed.articles, [{ title: 'Un modèle neuf', url: 'https://example.org/post', source: 'IA & outils', publishedAt: Date.parse('2026-10-22') }])
})
test('Atom : lien alternatif relatif, dates absentes, flux vide et XML invalide', () => {
  const feed = parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><entry><title>Article</title><link rel="self" href="/entry.xml"/><link rel="alternate" href="/article"/></entry></feed>', 'https://example.org/atom')
  assert.equal(feed.articles[0]?.url, 'https://example.org/article')
  assert.equal(feed.articles[0]?.publishedAt, null)
  assert.equal(parseFeed('<rss><channel><title>Vide</title></channel></rss>', 'https://example.org').articles.length, 0)
  for (const xml of ['<html><body>Not a feed</body></html>', '<rss>', '<!DOCTYPE rss [<!ENTITY x "boom">]><rss><channel/></rss>']) assert.throws(() => parseFeed(xml, 'https://example.org'))
})
test('SSRF : IPv4, IPv6, adresses mappées, protocoles et redirections', async () => {
  for (const address of ['127.0.0.1', '10.2.3.4', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.100.100.200', '0.0.0.0', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1']) assert.equal(isPublicAddress(address), false, address)
  assert.equal(isPublicAddress('8.8.8.8'), true)
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true)
  for (const url of ['file:///etc/passwd', 'https://user:pass@example.org/rss', 'http://example.org:7317/rss']) assert.throws(() => feedUrl(url))
  assert.equal(feedUrl('/next', 'https://example.org/feed').href, 'https://example.org/next')
  await assert.rejects(downloadFeed('http://2130706433/rss'), /news_url/)
  await assert.rejects(downloadFeed('http://[::ffff:127.0.0.1]/rss'), /news_url/)
})
test('Cache partagé, préférences privées, conservation après échec et expiration', async (t) => {
  const db = database(t)
  let now = Date.parse('2026-10-22T01:00:00Z')
  let calls = 0
  let fail = false
  const service = new NewsService(db, async (url) => { calls++; if (fail) throw Error('offline'); return { xml: rss, url } }, () => now)
  const prefs = { enabled: true, sources: [{ url: 'https://example.org/rss', enabled: true }] }
  writeNewsPreferences(db, 'alice', prefs)
  writeNewsPreferences(db, 'bob', { enabled: false, sources: [] })
  await Promise.all([service.preview(prefs.sources[0]!.url), service.preview(prefs.sources[0]!.url)])
  assert.equal(calls, 1)
  assert.equal(service.read('alice').articles.length, 1)
  assert.equal(service.read('bob').articles.length, 0)
  assert.equal(readUserSettings(db, 'bob').news.enabled, false)
  now += 3600001; fail = true
  await service.refreshSubscribed()
  assert.equal(service.read('alice').articles.length, 1)
  assert.equal(service.read('alice').sources[0]?.error, 'news_fetch')
  now += 31 * 86400000
  assert.equal(service.read('alice').articles.length, 0)
  await service.stop()
})
test('API : authentification, isolation des comptes, URL refusées et limite des tests', async (t) => {
  const db = database(t)
  const app = Fastify()
  registerErrorHandler(app)
  app.addHook('onRequest', async (request) => { request.user = db.select().from(users).all().find((u) => u.id === request.headers['x-user']) })
  registerNewsRoutes(app, { db, config: {} as Config })
  await app.ready()
  t.after(() => app.close())
  assert.equal((await app.inject('/api/news')).statusCode, 401)
  assert.equal((await app.inject({ method: 'PUT', url: '/api/me/news', headers: { 'x-user': 'alice' }, payload: { enabled: false, sources: [{ url: 'file:///etc/passwd', enabled: true }] } })).statusCode, 400)
  assert.equal((await app.inject({ method: 'PUT', url: '/api/me/news', headers: { 'x-user': 'alice' }, payload: { enabled: false, sources: [] } })).statusCode, 200)
  assert.notDeepEqual(readUserSettings(db, 'alice').news, readUserSettings(db, 'bob').news)
  for (let i = 0; i < 10; i++) assert.equal((await app.inject({ method: 'POST', url: '/api/news/preview', headers: { 'x-user': 'alice' }, payload: { url: 'http://127.0.0.1/feed' } })).statusCode, 400)
  assert.equal((await app.inject({ method: 'POST', url: '/api/news/preview', headers: { 'x-user': 'alice' }, payload: { url: 'https://example.org/rss' } })).statusCode, 429)
})
