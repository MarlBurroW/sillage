import { lookup } from 'node:dns/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import ipaddr from 'ipaddr.js'

export class FeedError extends Error {
  constructor(readonly code: string) { super(code) }
}

export function feedUrl(value: string, base?: string): URL {
  let url: URL
  try { url = new URL(value, base) } catch { throw new FeedError('news_url') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      (url.port && !['80', '443'].includes(url.port))) throw new FeedError('news_url')
  url.hash = ''
  return url
}

export function isPublicAddress(address: string): boolean {
  try { return ipaddr.process(address).range() === 'unicast' } catch { return false }
}

/** Connect to the validated address: resolving again would allow DNS rebinding. */
export async function publicAddress(hostname: string): Promise<{ address: string; family: number }> {
  const host = hostname.replace(/^\[|\]$/g, '')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const addresses = await Promise.race([
      lookup(host, { all: true }),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new FeedError('news_fetch')), 4000) }),
    ])
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new FeedError('news_url')
    return addresses[0]!
  } finally { clearTimeout(timer) }
}

const MAX_BYTES = 2 * 1024 * 1024
export async function downloadFeed(value: string): Promise<{ xml: string; url: string }> {
  let url = feedUrl(value)
  const signal = AbortSignal.timeout(15000)
  for (let redirects = 0; redirects <= 3; redirects++) {
    const address = await publicAddress(url.hostname)
    const response = await new Promise<{ status: number; location?: string; body: string }>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        signal,
        // TLS certificates and Host remain URL-derived; only DNS is pinned.
        lookup: (_host, options, callback) => {
          if (options.all) callback(null, [address])
          else callback(null, address.address, address.family)
        },
        headers: { 'user-agent': 'Sillage/1.0 (RSS reader)', accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml', 'accept-encoding': 'identity' },
      }, (res) => {
        const status = res.statusCode ?? 0
        if ([301, 302, 303, 307, 308].includes(status)) {
          res.destroy()
          resolve({ status, location: res.headers.location, body: '' })
          return
        }
        if (status !== 200 || (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity')) {
          res.destroy(); reject(new FeedError('news_fetch')); return
        }
        let bytes = 0
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => {
          bytes += chunk.length
          if (bytes > MAX_BYTES) res.destroy(new FeedError('news_size'))
          else chunks.push(chunk)
        })
        res.on('error', reject)
        res.on('end', () => resolve({ status, body: Buffer.concat(chunks).toString('utf8') }))
      })
      request.on('error', reject)
      request.end()
    })
    if (response.status === 200) return { xml: response.body, url: url.href }
    if (!response.location) throw new FeedError('news_fetch')
    url = feedUrl(response.location, url.href)
  }
  throw new FeedError('news_fetch')
}
