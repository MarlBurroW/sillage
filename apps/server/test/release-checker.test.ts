import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { ReleaseChecker } from '../src/update/release-checker.js'

/** The notes page places every release against the installed version, from one GitHub reply. */

function release(tag: string, extra: Record<string, unknown> = {}) {
  return {
    tag_name: tag,
    name: tag,
    body: `Notes for ${tag}`,
    published_at: '2026-11-01T00:00:00Z',
    html_url: `https://github.com/MarlBurroW/sillage/releases/tag/${tag}`,
    draft: false,
    prerelease: false,
    assets: [],
    ...extra,
  }
}

function stubGithub(t: TestContext, releases: unknown[]): { calls: () => number } {
  let calls = 0
  const original = globalThis.fetch
  globalThis.fetch = (async () => {
    calls += 1
    return new Response(JSON.stringify(releases), { status: 200 })
  }) as typeof fetch
  t.after(() => {
    globalThis.fetch = original
  })
  return { calls: () => calls }
}

const FEED = [
  release('v0.42.0'),
  release('v0.44.0'),
  release('v0.43.0'),
  release('v0.43.1'),
  release('v0.45.0', { prerelease: true }),
  release('v0.46.0', { draft: true }),
]

test('releases are sorted and placed against the installed version', async (t) => {
  stubGithub(t, FEED)
  const history = await new ReleaseChecker('0.43.0').getReleaseHistory()
  assert.equal(history.updateAvailable, true)
  assert.deepEqual(
    history.releases.map((entry) => [entry.tag, entry.relation]),
    [
      ['v0.44.0', 'newer'],
      ['v0.43.1', 'newer'],
      ['v0.43.0', 'installed'],
      ['v0.42.0', 'older'],
    ],
  )
  assert.equal(history.releases[0]?.body, 'Notes for v0.44.0')
})

test('an up-to-date instance has an installed release and nothing newer', async (t) => {
  stubGithub(t, FEED)
  const history = await new ReleaseChecker('0.44.0').getReleaseHistory()
  assert.equal(history.updateAvailable, false)
  assert.equal(history.releases.find((entry) => entry.relation === 'installed')?.tag, 'v0.44.0')
  assert.equal(history.releases.some((entry) => entry.relation === 'newer'), false)
})

test('a development build lists the releases without placing itself among them', async (t) => {
  stubGithub(t, FEED)
  const history = await new ReleaseChecker('dev').getReleaseHistory()
  assert.equal(history.updateAvailable, false)
  assert.equal(history.releases.length, 4)
  assert.ok(history.releases.every((entry) => entry.relation === null))
})

test('the notes and the version check share one GitHub request', async (t) => {
  const github = stubGithub(t, FEED)
  const checker = new ReleaseChecker('0.43.0')
  const [info, history] = await Promise.all([checker.getVersionInfo(), checker.getReleaseHistory()])
  await checker.getReleaseHistory()
  assert.equal(github.calls(), 1)
  assert.equal(info.latest, '0.44.0')
  assert.deepEqual(info.releases.map((note) => note.tag), ['v0.44.0', 'v0.43.1'])
  assert.equal(history.releases.length, 4)
})
