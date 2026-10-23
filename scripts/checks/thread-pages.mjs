import assert from 'node:assert/strict'

export async function checkThreadPages(page) {
  const result = await page.evaluate(async () => {
    const React = (await import('/node_modules/.vite/deps/react.js')).default
    const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default
    const source = await (await fetch('/src/lib/use-chat-stream.ts')).text()
    const { QueryClient, QueryClientProvider } = await import(source.match(/from ["']([^"']*tanstack[^"']+)["']/)[1])
    const { useChatStream } = await import('/src/lib/use-chat-stream.ts')
    const { emptyChatState, applyEvent, serializeChatState } = await import('/src/lib/chat-fold.ts')
    const { JOURNAL_CACHE_BYTES, retainedBytes } = await import('/src/lib/cache-budget.ts')
    const { api } = await import('/src/lib/api.ts')
    const { wsClient } = await import('/src/lib/ws-client.ts')
    const saved = { get: api.get, subscribe: wsClient.subscribe, setCursor: wsClient.setCursor }
    const client = new QueryClient()
    const host = document.createElement('div'); document.body.append(host)
    const root = createRoot(host)
    let latest, subscription, resolveLate, cancelled
    const requests = []
    const check = (value, message) => { if (!value) throw Error(message) }
    const until = async (predicate) => {
      const end = performance.now() + 6000
      while (!predicate()) { if (performance.now() > end) throw Error('Projection UI timeout'); await new Promise((r) => setTimeout(r, 5)) }
    }
    const message = (seq, id, text) => ({ seq, event: { type: 'message.completed', messageId: id, role: 'assistant', parentToolCallId: null, blocks: [{ type: 'text', text }] } })
    const body = (entries, cursor, before, hasMore) => {
      let state = emptyChatState()
      for (const { seq, event } of entries) state = applyEvent(state, seq, seq, event)
      state.lastSeq = cursor
      return { building: false, state: serializeChatState(state), cursor, before, hasMore, reset: false }
    }
    api.get = async (url, signal) => {
      const query = new URL(url, location.origin)
      const before = query.searchParams.get('before')
      requests.push({ url, before })
      if (url.includes('/slow/thread') && before) { cancelled = signal; return new Promise((resolve) => { resolveLate = resolve }) }
      if (url.includes('/paged/thread') && before === '0') return body([message(10, 'omitted', 'original + late')], 101, 0, false)
      if (url.includes('/paged/thread') && before === '100') return body([message(1, 'old', 'earlier'), message(100, 'recent', 'recent updated'), message(102, 'new', 'new')], 102, 1, false)
      if (/\/cache-\d+\/thread/.test(url)) return body([message(1, 'large', 'x'.repeat(500_000))], 1, 1, false)
      if (url.includes('/events?')) return { entries: [], nextAfter: Number(query.searchParams.get('after')), lastSeq: Number(query.searchParams.get('after')) }
      return body([message(100, 'recent', 'recent')], 100, 100, true)
    }
    wsClient.setCursor = () => {}
    wsClient.subscribe = (id, after, listener) => {
      const sub = { id, after, listener, active: true }; subscription = sub
      return () => { sub.active = false }
    }
    function Probe({ id }) {
      const stream = useChatStream(id, 'idle')
      React.useEffect(() => { latest = { id, ...stream } })
      return null
    }
    const visit = async (id) => {
      root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Probe, { id })))
      await until(() => latest?.id === id && !latest.loading && subscription?.id === id)
    }
    try {
      await visit('paged')
      check(latest.state.items.length === 1 && latest.hasMore, 'Initial state must only load recent items')
      subscription.listener.onEvent(101, 101, message(101, 'omitted', 'late').event)
      await until(() => subscription.after === 101)
      check(latest.state.items.find((item) => item.id === 'omitted')?.position === 10, 'Late block must recover its original row')
      check(latest.hasMore, 'A delta refresh must preserve history pagination')
      await latest.loadOlder()
      await until(() => subscription.after === 102 && latest.state.lastSeq === 102 && !latest.loadingOlder)
      check(latest.state.items.map((item) => item.position).join(',') === '1,10,100,102', `History positions: ${latest.state.items.map((item) => item.position).join(',')}`)
      check(latest.state.items.find((item) => item.id === 'recent').blocks[0].text === 'recent updated', 'Page must include concurrent edits to loaded rows')
      check(!latest.hasMore, 'End of history must be explicit')
      await visit('slow')
      void latest.loadOlder()
      await until(() => resolveLate)
      await visit('other')
      check(cancelled.aborted, 'Leaving an older-page request must abort it')
      resolveLate(body([message(1, 'obsolete', 'obsolete')], 100, 1, false))
      await new Promise((r) => setTimeout(r, 20))
      check(latest.id === 'other' && !latest.state.items.some((item) => item.id === 'obsolete'), 'Late page contaminated the current conversation')
      for (let i = 0; i < 20; i++) await visit(`cache-${i}`)
      const entries = client.getQueryCache().findAll({ queryKey: ['chat-journal-snapshot-v1'] })
      const bytes = entries.reduce((sum, entry) => sum + entry.state.data.bytes, 0)
      check(bytes <= JOURNAL_CACHE_BYTES && entries.length < 10, 'Twenty large sessions exceeded the retained byte budget')
      check(retainedBytes('x'.repeat(5_000_000), JOURNAL_CACHE_BYTES) > JOURNAL_CACHE_BYTES, 'Oversized snapshots must be excluded')
      return { bytes, entries: entries.length }
    } finally { root.unmount(); host.remove(); client.clear(); api.get = saved.get; wsClient.subscribe = saved.subscribe; wsClient.setCursor = saved.setCursor }
  })
  assert.ok(result.bytes <= 8 * 1024 * 1024)
  console.log(`OK: paged history, late blocks, concurrent patches, cancellation and 20 cache visits (${result.entries} snapshots).`)
}
