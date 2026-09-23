import assert from 'node:assert/strict'

// Le vrai hook reprend après le curseur lu, même si les deltas ont été fusionnés.
export async function checkJournalCache(page) {
  const result = await page.evaluate(async () => {
    const React = (await import('/node_modules/.vite/deps/react.js')).default
    const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default
    const hookSource = await (await fetch('/src/lib/use-chat-stream.ts')).text()
    const queryModule = hookSource.match(/from ["']([^"']*tanstack[^"']+)["']/)[1]
    const { QueryClient, QueryClientProvider } = await import(queryModule)
    const { useChatStream } = await import('/src/lib/use-chat-stream.ts')
    const { wsClient } = await import('/src/lib/ws-client.ts')
    const { api } = await import('/src/lib/api.ts')
    const client = new QueryClient()
    const requests = []
    let updated = false
    api.get = async (url) => {
      const after = Number(new URL(url, location.origin).searchParams.get('after'))
      requests.push(after)
      return {
        entries: after === 0
          ? [{ seq: 1, ts: 1, event: { type: 'message.delta', messageId: 'm', text: 'Bonjour', parentToolCallId: null } }]
          : updated && after === 10
            ? [{ seq: 11, ts: 11, event: { type: 'message.delta', messageId: 'm', text: ' !', parentToolCallId: null } }]
            : [],
        nextAfter: updated ? 11 : 10,
        lastSeq: updated ? 11 : 10,
      }
    }
    wsClient.subscribe = () => () => {}
    const host = document.createElement('div')
    document.body.append(host)
    let root
    async function visit(id) {
      let timer
      return await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Journal hook timeout')), 5000)
        function Probe() {
          const stream = useChatStream(id, 'idle')
          React.useEffect(() => {
            if (!stream.loading) resolve(stream.state.items[0]?.streamingText)
          }, [stream.loading, stream.state])
          return null
        }
        root = createRoot(host)
        root.render(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)))
      }).finally(() => { clearTimeout(timer); root?.unmount() })
    }
    const first = await visit('one')
    updated = true
    const second = await visit('one')
    const third = await visit('one')
    for (const id of ['two', 'three', 'four', 'five']) await visit(id)
    const count = client.getQueryCache().findAll({ queryKey: ['chat-journal-snapshot'] }).length
    client.removeQueries()
    await visit('one')
    client.clear()
    host.remove()
    return { first, second, third, requests, count }
  })
  assert.equal(result.first, 'Bonjour')
  assert.equal(result.second, 'Bonjour !')
  assert.equal(result.third, 'Bonjour !')
  assert.deepEqual(result.requests.slice(0, 3), [0, 10, 11])
  assert.equal(result.requests.at(-1), 0, 'La déconnexion efface le cache')
  assert.equal(result.count, 4, 'Le cache reste borné')
  console.log('OK : retour au fil sans rejeu complet, deltas fusionnés, cache borné et effacement.')
}
