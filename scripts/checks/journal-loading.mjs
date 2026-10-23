import assert from 'node:assert/strict'

// Exercise the real hook, pagination and API wrapper against delayed HTTP/WS
// deliveries. The UI must survive cancellation even when a transport replies late.
export async function checkJournalLoading(page) {
  const checked = await page.evaluate(async () => {
    const React = (await import('/node_modules/.vite/deps/react.js')).default
    const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default
    const source = await (await fetch('/src/lib/use-chat-stream.ts')).text()
    const { QueryClient, QueryClientProvider } = await import(source.match(/from ["']([^"']*tanstack[^"']+)["']/)[1])
    const { useChatStream } = await import('/src/lib/use-chat-stream.ts')
    const { fetchJournal } = await import('/src/lib/conversations.ts')
    const { api } = await import('/src/lib/api.ts')
    const { wsClient } = await import('/src/lib/ws-client.ts')
    const originals = { fetch: window.fetch, subscribe: wsClient.subscribe, setCursor: wsClient.setCursor }
    const client = new QueryClient()
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    const requests = []
    const projectionRequests = []
    const subscriptions = []
    const handlers = new Map()
    const checked = []
    let latest
    const check = (condition, message) => { if (!condition) throw new Error(message) }
    const pause = () => new Promise((resolve) => setTimeout(resolve, 5))
    async function until(predicate) {
      const end = performance.now() + 5000
      while (!predicate()) {
        if (performance.now() > end) throw new Error(`Journal check timed out: ${JSON.stringify({ latest, requests: requests.map(({ id, after }) => ({ id, after })) })}`)
        await pause()
      }
    }
    function deferred() {
      let resolve
      const promise = new Promise((done) => { resolve = done })
      return { promise, resolve }
    }
    const delta = (seq, text) => ({ seq, ts: seq, event: { type: 'message.delta', messageId: 'm', text, parentToolCallId: null } })
    const response = (entries, nextAfter, lastSeq = nextAfter) => new Response(JSON.stringify({ entries, nextAfter, lastSeq }), { headers: { 'content-type': 'application/json' } })
    const text = () => latest?.state.items.filter((item) => item.kind === 'message').map((item) => item.streamingText).join('')
    const active = (id) => subscriptions.findLast((sub) => sub.id === id && sub.active)
    function Probe({ id }) {
      const stream = useChatStream(id, 'idle')
      React.useEffect(() => { latest = { id, ...stream } })
      return null
    }
    function render(id, strict = false) {
      root.render(React.createElement(strict ? React.StrictMode : React.Fragment, null,
        React.createElement(QueryClientProvider, { client }, React.createElement(Probe, { id }))))
    }
    const loaded = (id) => until(() => latest?.id === id && !latest.loading && active(id))
    window.fetch = async (url, options) => {
      if (String(url).includes('/thread?')) { projectionRequests.push({ url: String(url), signal: options?.signal }); return new Response('{}', { status: 404 }) }
      const match = String(url).match(/\/conversations\/([^/]+)\/events\?after=(\d+)/)
      if (!match) return originals.fetch(url, options)
      const entry = { id: match[1], after: Number(match[2]), signal: options?.signal }
      requests.push(entry)
      return handlers.get(entry.id)?.(entry) ?? response([delta(1, entry.id)], 1)
    }
    wsClient.setCursor = () => {}
    wsClient.subscribe = (id, after, listener) => {
      const sub = { id, after, listener, active: true }
      subscriptions.push(sub)
      listener.onConnectionChange(true)
      return () => { sub.active = false }
    }

    try {
      const slow = deferred()
      handlers.set('slow', () => slow.promise)
      render('slow')
      await until(() => requests.some((entry) => entry.id === 'slow'))
      render('other')
      await loaded('other')
      check(requests.find((entry) => entry.id === 'slow').signal.aborted, 'Leaving must abort the in-flight HTTP request')
      slow.resolve(response([delta(1, 'obsolete')], 10, 20))
      await pause()
      check(requests.filter((entry) => entry.id === 'slow').length === 1, 'Cancelled replay requested another page')
      check(text() === 'other' && latest.error === null, 'Old replay contaminated the new conversation')
      check(!active('slow'), 'Cancelled replay opened a socket subscription')
      checked.push('navigation cancellation')

      // A cached state must not be mutated by subsequent live events. The cursor
      // after a merged delta also excludes later fragments within that same page.
      handlers.set('cached', ({ after }) => after === 0
        ? response([delta(1, 'Hello')], 10)
        : after === 10 ? response([delta(11, '!'), delta(12, '?')], 20) : response([], after))
      render('cached')
      await loaded('cached')
      active('cached').listener.onEvent(11, 11, delta(11, '!').event)
      active('cached').listener.onEvent(12, 12, delta(12, '?').event)
      await until(() => text() === 'Hello!?')
      render('other')
      await loaded('other')
      render('cached')
      await loaded('cached')
      check(text() === 'Hello!?', 'Live events mutated the cached snapshot or replayed twice')
      check(active('cached').after === 20, 'Subscription resumed from the last rendered seq instead of the read cursor')
      active('cached').listener.onEvent(15, 15, delta(15, 'duplicate').event)
      active('cached').listener.onEvent(21, 21, delta(21, '.').event)
      await until(() => text() === 'Hello!?.')
      checked.push('snapshot isolation and merged cursor')

      const catchup = deferred()
      handlers.set('reconnect', ({ after }) => after === 0 ? response([delta(1, 'start')], 10) : catchup.promise)
      render('reconnect')
      await loaded('reconnect')
      const old = active('reconnect')
      old.listener.onConnectionChange(false)
      old.listener.onConnectionChange(true)
      await until(() => requests.some((entry) => entry.id === 'reconnect' && entry.after === 10))
      old.listener.onCatchupNeeded()
      old.listener.onConnectionChange(true)
      old.listener.onEvent(21, 21, delta(21, 'end').event)
      check(!active('reconnect'), 'Live events must not overtake REST catch-up')
      check(requests.filter((entry) => entry.id === 'reconnect').length === 2, 'Overlapping catch-up requests')
      catchup.resolve(response([delta(11, ' middle ')], 20))
      await until(() => active('reconnect')?.after === 20)
      // Represents the server's journal replay of work completed during REST.
      active('reconnect').listener.onEvent(21, 21, delta(21, 'end').event)
      await until(() => text() === 'start middle end')
      check(latest.error === null, 'Recovered connection still reports an error')
      checked.push('single catch-up and live handover')

      handlers.set('gap', ({ after }) => after === 0
        ? response([delta(1, 'before')], 10)
        : response([delta(11, ' missing'), delta(13, ' after')], 13))
      render('gap')
      await loaded('gap')
      active('gap').listener.onEvent(13, 13, delta(13, ' after').event)
      await until(() => active('gap')?.after === 13)
      check(text() === 'before missing after', 'A late or sparse frame hid missing history')
      check(requests.filter((entry) => entry.id === 'gap').length === 2, 'Sparse replay did not converge at its examined cursor')
      checked.push('sparse or late live frames')

      let failed = false
      handlers.set('retry', ({ after }) => {
        if (after === 0) return response([delta(1, 'kept')], 10, 30)
        if (after === 10) return response([], 20, 30)
        if (!failed) { failed = true; return new Response('{}', { status: 500 }) }
        return response([delta(21, ' recovered')], 30)
      })
      render('retry')
      await loaded('retry')
      check(Boolean(latest.error) && active('retry').after === 20, 'Failed replay lost the last fully read page cursor')
      active('retry').listener.onCatchupNeeded()
      await until(() => active('retry')?.after === 30 && latest?.error === null)
      check(text() === 'kept recovered', 'Retry lost or duplicated partially loaded state')
      check(JSON.stringify(requests.filter((entry) => entry.id === 'retry').map((entry) => entry.after)) === '[0,10,20,20]', 'Retry replayed already folded pages')
      checked.push('partial failure and filtered pages')

      const between = new AbortController()
      let pages = 0
      handlers.set('between', () => response([delta(1, 'one')], 10, 20))
      await fetchJournal('between', 0, () => { pages++; between.abort() }, between.signal).then(
        () => { throw new Error('Cancellation between pages resolved successfully') },
        (error) => check(error.name === 'AbortError', 'Unexpected cancellation error'),
      )
      check(pages === 1 && requests.filter((entry) => entry.id === 'between').length === 1, 'Fetched after callback cancellation')
      checked.push('pagination cancellation')

      const body = deferred(), duringBody = new AbortController()
      let reading = false
      handlers.set('body', () => ({ status: 200, ok: true, text: () => { reading = true; return body.promise } }))
      const pendingBody = api.get('/api/conversations/body/events?after=0', duringBody.signal).then(
        () => { throw new Error('Aborted response body was accepted') },
        (error) => check(error.name === 'AbortError', 'Unexpected body cancellation error'),
      )
      await until(() => reading)
      duringBody.abort()
      body.resolve('{}')
      await pendingBody
      checked.push('API signal and body cancellation')

      handlers.set('legacy', () => new Response(JSON.stringify({ entries: [delta(7, 'old server')], lastSeq: 7 })))
      const cursors = []
      const legacyCursor = await fetchJournal('legacy', 0, (_entries, cursor) => cursors.push(cursor))
      check(legacyCursor === 7 && cursors[0] === 7, 'Older server cursor fallback regressed')

      // StrictMode starts and cleans up the first effect while its request is pending.
      render('strict', true)
      await loaded('strict')
      check(text() === 'strict', 'StrictMode replay duplicated the conversation')
      check(projectionRequests.filter((entry) => entry.url.includes('/strict/')).some((entry) => entry.signal.aborted), 'StrictMode did not abort its abandoned effect')
      check(subscriptions.filter((sub) => sub.active).length === 1, 'Multiple live subscriptions remain')
      checked.push('legacy server and StrictMode')
      return checked
    } finally {
      root.unmount()
      client.clear()
      host.remove()
      window.fetch = originals.fetch
      wsClient.subscribe = originals.subscribe
      wsClient.setCursor = originals.setCursor
    }
  })
  assert.equal(checked.length, 8)
  console.log(`OK: journal lifecycle (${checked.join(', ')}).`)
}
