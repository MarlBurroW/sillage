import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout } from 'node:timers/promises'
import { CodexAppServerClient, CodexRpcError } from '../src/agents/codex/app-server-client.js'
import { fixture } from './codex-support.js'

test('handshake complet et erreurs RPC structurées', async (t) => {
  const files = await fixture(t)
  const client = new CodexAppServerClient(files)
  files.onClose(() => client.close())
  await client.initialize({ name: 'test', version: '1', title: null })
  await client.call('thread/start', {})
  const records = await files.records()
  assert.deepEqual(records.slice(0, 3).map((record) => record.method), ['initialize', 'initialized', 'thread/start'])
  await assert.rejects(client.callExperimental('fixture/error', {}), (error: unknown) =>
    error instanceof CodexRpcError && error.code === -32602 && error.message === 'Invalid fixture input')
})

test('ids RPC chaîne et numérique, annulation native sans réponse tardive', async (t) => {
  const files = await fixture(t)
  const ids: (string | number)[] = []
  let release: (value: unknown) => void = () => {}
  const client = new CodexAppServerClient({ ...files, onServerRequest: async (_method, _params, id) => {
    ids.push(id)
    return id === 'cancelled' ? new Promise((resolve) => { release = resolve }) : { answer: id }
  } })
  files.onClose(() => client.close())
  await client.initialize({ name: 'test', version: '1', title: null })
  await client.callExperimental('fixture/emit', { requests: [0, 'string-id', 'cancelled'].map((id) => ({ id, method: 'question', params: {} })) })
  await client.callExperimental('fixture/emit', { notifications: [{ method: 'serverRequest/resolved', params: { requestId: 'cancelled', threadId: 'root' } }] })
  release({ answer: 'late' })
  await client.callExperimental('fixture/emit', {}) // Barrière après les écritures.
  assert.deepEqual(ids, [0, 'string-id', 'cancelled'])
  const answers = (await files.records()).filter((record) => record.result)
  assert.deepEqual(answers.map((record) => record.id), [0, 'string-id'])
})

test('stdout non JSON ou null ne casse pas le transport', async (t) => {
  const files = await fixture(t)
  const client = new CodexAppServerClient(files)
  files.onClose(() => client.close())
  await client.initialize({ name: 'test', version: '1', title: null })
  await client.callExperimental('fixture/emit', { lines: ['a CLI diagnostic', 'null', '[]'] })
  await client.call('thread/start', {})
})

test('binaire absent : rejet immédiat et une seule notification de mort', async () => {
  let exits = 0
  const client = new CodexAppServerClient({ binary: '/nonexistent/sillage-codex-fixture', onExit: () => { exits++ } })
  await assert.rejects(client.initialize({ name: 'test', version: '1', title: null }), /ENOENT/)
  await setTimeout(0)
  assert.equal(exits, 1)
  client.close()
})
