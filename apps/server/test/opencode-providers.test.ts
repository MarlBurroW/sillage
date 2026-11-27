import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OpencodeProviders, OpencodeProvidersUnsupported } from '../src/agents/opencode/providers.js'
import { fixture } from './opencode-support.js'
import { fixture2 } from './opencode2-support.js'

test('fournisseurs OpenCode 2 : clé transmise une fois, jamais relue, catalogue invalidé', async (t) => {
  const { binary, records } = await fixture2(t)
  let changes = 0
  const providers = new OpencodeProviders(async () => binary, () => { changes++ })

  // Connected providers first: an environment variable counts.
  assert.deepEqual((await providers.list()).map((provider) => [provider.id, provider.acceptsKey, provider.connections.length]),
    [['vertex', false, 1], ['anthropic', true, 0], ['zeta', true, 0]])

  await providers.connectKey('anthropic', 'sk-typed', 'Work')
  const listed = await providers.list()
  assert.deepEqual(listed.find((provider) => provider.id === 'anthropic')?.connections, [{ type: 'credential', id: 'cred_1', label: 'Work', method: 'key' }])
  assert.equal(JSON.stringify(listed).includes('sk-typed'), false)
  const sent = (await records()).filter((record) => record.path === '/api/integration/anthropic/connect/key')
  assert.deepEqual(sent.map((record) => record.body), [{ key: 'sk-typed', label: 'Work' }])
  // Keys are read back by GET /api/credential: Sillage never asks.
  assert.equal((await records()).some((record) => record.method === 'GET' && record.path === '/api/credential'), false)

  await providers.disconnect('cred_1')
  assert.deepEqual((await providers.list()).find((provider) => provider.id === 'anthropic')?.connections, [])
  assert.equal(changes, 2)
})

test('fournisseurs OpenCode : la 1.x est refusée, sans rien écrire', async (t) => {
  const { binary } = await fixture(t)
  const providers = new OpencodeProviders(async () => binary, () => assert.fail('nothing changed'))
  await assert.rejects(providers.list(), OpencodeProvidersUnsupported)
  await assert.rejects(providers.connectKey('anthropic', 'sk-typed'), OpencodeProvidersUnsupported)
})
