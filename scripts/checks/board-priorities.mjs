import assert from 'node:assert/strict'

export async function checkBoardPriorities(page) {
  await page.evaluate(async () => {
    const React = (await import('/node_modules/.vite/deps/react.js')).default
    const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default
    const { McpPane } = await import('/src/components/panel/McpPane.tsx')
    const { WorktreePullRequest } = await import('/src/components/WorktreePullRequest.tsx')
    const { applyEvent, emptyChatState } = await import('/src/lib/chat-fold.ts')
    const host = document.createElement('div')
    host.id = 'board-priorities-check'
    document.body.append(host)
    const root = createRoot(host)
    let state = emptyChatState()
    let seq = 0
    window.renderDiscovery = (toolsError) => {
      state = applyEvent(state, ++seq, Date.now(), {
        type: 'mcp.updated',
        servers: [{ name: 'catalog-test', state: 'connected', tools: [], error: null, toolsError, external: false }],
      })
      root.render(React.createElement(React.Fragment, null,
        React.createElement(McpPane, { servers: state.mcp, agent: 'codex', conversationId: 'fixture' }),
        React.createElement(WorktreePullRequest, { pull: {
          number: 42, url: 'https://github.com/example/repo/pull/42',
          head: 'abc', base: 'main', state: 'closed', checks: null,
        } }),
      ))
    }
    window.cleanupDiscovery = () => { root.unmount(); host.remove() }
    window.renderDiscovery('tools/list: upstream unavailable')
  })
  const host = page.locator('#board-priorities-check')
  await host.getByText('Connecté', { exact: true }).waitFor()
  await host.getByText('Impossible de charger les outils : tools/list: upstream unavailable', { exact: true }).waitFor()
  const link = host.getByRole('link', { name: 'PR nº 42', exact: true })
  assert.equal(await link.getAttribute('href'), 'https://github.com/example/repo/pull/42')
  await host.getByText('Fermée sans fusion', { exact: false }).waitFor()
  await link.focus()
  assert.equal(await link.evaluate(element => element === document.activeElement), true)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  const longError = `tools/list: ${'upstream-catalog-unavailable/'.repeat(30)}`
  await page.evaluate((error) => window.renderDiscovery(error), longError)
  await host.getByText(`Impossible de charger les outils : ${longError}`, { exact: true }).waitFor()
  assert.equal(await host.evaluate(element => element.scrollWidth <= element.clientWidth), true)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.evaluate(() => window.renderDiscovery(null))
  await host.getByText('Impossible de charger les outils', { exact: false }).waitFor({ state: 'hidden' })
  await host.getByText('Connecté', { exact: true }).waitFor()
  await page.evaluate(() => window.cleanupDiscovery())
  console.log('OK: MCP discovery errors survive replay and clear on recovery; PR state/link accessible.')
}
