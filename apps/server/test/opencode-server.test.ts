import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { OpencodeServer, isPortClash } from '../src/agents/opencode/server.js'
import { fixture2 } from './opencode2-support.js'

test('port pris : reconnu dans les mots des vrais binaires, pas dans une autre panne', () => {
  // Outputs of 2.4.2 and 1.19.3 with their port already taken (probed).
  assert.equal(isPortClash('ServeError: \n  [cause]: Error: Failed to start server. Is port 47412 in use?'), true)
  assert.equal(isPortClash('\u001b[91m\u001b[1mError: \u001b[0mUnexpected error\n\nServeError'), true)
  assert.equal(isPortClash('Error: listen EADDRINUSE: address already in use 127.0.0.1:4096'), true)
  assert.equal(isPortClash('Error: Configuration is invalid at OPENCODE_CONFIG_CONTENT'), false)
})

for (const [label, text] of [['2.x', '2'], ['1.19', '1']] as const) {
  test(`port pris au démarrage (${label}) : opencode est relancé sur un autre port`, async (t) => {
    const { binary, cwd } = await fixture2(t)
    const marker = join(cwd, 'port-taken')
    const server = await OpencodeServer.start({
      binary, cwd, generation: 2, config: {},
      env: { ...process.env, FIXTURE_PORT_TAKEN: marker, FIXTURE_PORT_TAKEN_TEXT: text },
    })
    t.after(() => server.close())
    // The first launch hit the taken port; the second one serves.
    assert.ok(existsSync(marker))
    assert.ok(await server.get('/api/session/ses_root'))
  })
}
