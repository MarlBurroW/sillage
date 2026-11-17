import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk'
import { claudeCredential, claudeCredentialOfEnv } from '../src/agents/claude/credential.js'
import { ClaudeModelCatalog, isReducedCatalog, type Listing } from '../src/agents/claude/model-catalog.js'

const row = (value: string, resolvedModel: string): ModelInfo =>
  ({ value, resolvedModel, displayName: value, description: '' }) as ModelInfo

// Both answers of Claude Code 2.1.318 under one login, probed on 12 Nov 2026.
const SERVED = [
  row('default', 'claude-fable-5-1'), row('opus', 'claude-opus-5-5'), row('claude-fable-5-2', 'claude-fable-5-2'),
  row('sonnet', 'claude-sonnet-5-5'), row('haiku', 'claude-haiku-5-5'), row('fable', 'claude-fable-5-1'),
  row('claude-opus-5', 'claude-opus-5'),
]
const COMPILED = [
  row('default', 'claude-opus-5-5'), row('opus', 'claude-opus-5-5'), row('claude-fable-5-1[1m]', 'claude-fable-5-1'),
  row('sonnet', 'claude-sonnet-5-5'), row('haiku', 'claude-haiku-5-5'),
]

const account = { email: 'a@example.com', organization: 'Org', subscriptionType: 'max' }
const listing = (models: ModelInfo[], fields: Partial<Listing> = {}): Listing => ({
  models, account, cliVersion: '2.1.318', outputStyles: [], agents: [], fastMode: { state: null, reason: null }, ...fields,
})

test('the compiled list is a reduced view of the served catalog, not the reverse', () => {
  assert.equal(isReducedCatalog(listing(COMPILED), listing(SERVED)), true)
  assert.equal(isReducedCatalog(listing(SERVED), listing(COMPILED)), false)
  assert.equal(isReducedCatalog(listing(SERVED), listing(SERVED)), false)
})

test('another CLI, another plan or a new model is a real change', () => {
  const served = listing(SERVED)
  assert.equal(isReducedCatalog(listing(COMPILED, { cliVersion: '2.1.319' }), served), false)
  assert.equal(isReducedCatalog(listing(COMPILED, { account: { ...account, subscriptionType: 'pro' } }), served), false)
  assert.equal(isReducedCatalog(listing([...COMPILED.slice(1), row('claude-new-6', 'claude-new-6')]), served), false)
})

/** Catalog answering with the given lists in turn, one per probe. */
function catalogAnswering(answers: ModelInfo[][], options: { storePath?: string; now?: () => number } = {}) {
  let calls = 0
  return new ClaudeModelCatalog(async () => 'claude', {
    ...options,
    probe: async () => listing(answers[Math.min(calls++, answers.length - 1)]!),
  })
}

/** Expire the probe cache only: `invalidate` would also forget the kept list. */
const expireProbes = (catalog: ClaudeModelCatalog) =>
  (catalog as unknown as { cached: { invalidate(): void } }).cached.invalidate()

const values = (models: ModelInfo[]) => models.map((model) => model.value)

test('a probe that comes back reduced keeps the fuller list, on a refresh too', async () => {
  const catalog = catalogAnswering([SERVED, COMPILED, COMPILED])
  assert.deepEqual(values((await catalog.list()).models), values(SERVED))
  expireProbes(catalog)
  assert.deepEqual(values((await catalog.list()).models), values(SERVED))
  // The refresh would start a CLI on the same stale flag.
  assert.deepEqual(values((await catalog.list(undefined, true)).models), values(SERVED))
})

test('the fuller list survives a restart, named by a digest of the credential', async () => {
  const storePath = join(mkdtempSync(join(tmpdir(), 'sillage-catalog-')), 'catalog.json')
  await catalogAnswering([SERVED], { storePath }).list('oauth:secret-token')
  assert.equal(readFileSync(storePath, 'utf8').includes('secret-token'), false)

  const restarted = catalogAnswering([COMPILED], { storePath })
  assert.equal(restarted.defaultModel('oauth:secret-token'), 'claude-fable-5-1')
  assert.deepEqual(values((await restarted.list('oauth:secret-token')).models), values(SERVED))
})

test('a fuller list the CLI has not confirmed for a week gives way', async () => {
  let now = Date.now()
  const catalog = catalogAnswering([SERVED, COMPILED], { now: () => now })
  await catalog.list()
  now += 8 * 24 * 60 * 60 * 1000
  expireProbes(catalog)
  assert.deepEqual(values((await catalog.list()).models), values(COMPILED))
})

test('a CLI installation forgets the kept lists', async () => {
  const catalog = catalogAnswering([SERVED, COMPILED])
  await catalog.list()
  catalog.invalidate()
  assert.deepEqual(values((await catalog.list()).models), values(COMPILED))
})

test('accounts keep separate lists', async () => {
  const catalog = catalogAnswering([SERVED, COMPILED])
  await catalog.list()
  assert.equal((await catalog.list('oauth:other')).models.length, COMPILED.length)
})

test('the default model is the one the shown list announces, per account, without probing', async () => {
  const catalog = catalogAnswering([SERVED, COMPILED])
  assert.equal(catalog.defaultModel(), null)
  await catalog.list()
  assert.equal(catalog.defaultModel(), 'claude-fable-5-1')
  assert.equal(catalog.defaultModel('oauth:other'), null)
})

test('a launch environment names its account credential', () => {
  assert.equal(claudeCredentialOfEnv(undefined), undefined)
  assert.equal(claudeCredentialOfEnv({ SILLAGE_PROCESS_ORIGIN: 'x' }), undefined)
  assert.equal(claudeCredentialOfEnv({ CLAUDE_CODE_OAUTH_TOKEN: 't' }), claudeCredential('oauth', 't'))
  assert.equal(claudeCredentialOfEnv({ ANTHROPIC_API_KEY: 'k' }), claudeCredential('apiKey', 'k'))
})
