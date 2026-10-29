import assert from 'node:assert/strict'
import { test } from 'node:test'
import { searchSkillsSh, skillsShDescription } from '../src/skill-library/skills-sh.js'

test('directory metadata preserves identifiers and loads cached descriptions without cloning', async (t) => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    calls++
    if (url.includes('/api/search')) return Response.json({ skills: [
      { source: 'team/repo', name: 'Display name', skillId: 'actual-slug', installs: 15 },
      { source: 'https://untrusted.example', name: 'invalid' },
    ] })
    assert.equal(url, 'https://www.skills.sh/team/repo/actual-slug')
    return new Response('<script type="application/ld+json">{bad json}</script><script type="application/ld+json">' +
      JSON.stringify({ '@type': 'SoftwareApplication', description: 'Video generation & editing.\nRequirements included.' }) + '</script>')
  })
  assert.deepEqual(await searchSkillsSh('video'), [
    { repository: 'team/repo', name: 'Display name', slug: 'actual-slug', installs: 15 },
  ])
  const descriptions = await Promise.all([skillsShDescription('team/repo', 'actual-slug'), skillsShDescription('team/repo', 'actual-slug')])
  assert.deepEqual(descriptions, ['Video generation & editing.\nRequirements included.', 'Video generation & editing.\nRequirements included.'])
  assert.equal(calls, 2)
})

test('missing, changed, failed and oversized directory pages degrade to unavailable descriptions', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    if (url.endsWith('/missing')) return new Response('', { status: 404 })
    if (url.endsWith('/offline')) throw new Error('offline')
    if (url.endsWith('/oversized')) return new Response('x'.repeat(1_000_001))
    return new Response('<html>No structured skill metadata</html>')
  })
  for (const slug of ['missing', 'offline', 'oversized', 'changed']) {
    assert.equal(await skillsShDescription('test/fallback', slug), null)
  }
})
