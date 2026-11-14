import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GitHubIssues } from '../src/board/github-issues.js'

test('PR reads encode branch names, paginate and combine both GitHub check mechanisms', async () => {
  const paths: URL[] = []
  let status = { state: 'success', total_count: 1 }
  let checks = { total_count: 1, check_runs: [{ status: 'completed', conclusion: 'success' as string | null }] }
  const client = new GitHubIssues('fixture-token', 'owner/repo', async (url, init) => {
    assert.equal(init?.method, 'GET')
    assert.equal((init?.headers as Record<string, string>).authorization, 'Bearer fixture-token')
    const target = new URL(url)
    paths.push(target)
    const body = target.pathname.endsWith('/pulls')
      ? (target.searchParams.get('page') === '1' ? Array.from({ length: 100 }, (_, i) => ({ number: i + 1 })) : [{ number: 101 }])
      : target.pathname.endsWith('/status') ? status : checks
    return Response.json(body)
  })
  const pulls = await client.listPullRequests('owner:feature/a&b')
  assert.equal(pulls.length, 101)
  assert.equal(paths[0]?.searchParams.get('head'), 'owner:feature/a&b')
  assert.equal(paths[0]?.searchParams.get('state'), 'all')
  assert.equal(await client.checks('abc'), 'success')
  checks = { total_count: 1, check_runs: [{ status: 'in_progress', conclusion: null }] }
  assert.equal(await client.checks('abc'), 'pending')
  checks = { total_count: 1, check_runs: [{ status: 'completed', conclusion: 'failure' }] }
  assert.equal(await client.checks('abc'), 'failure')
  status = { state: 'pending', total_count: 0 }
  checks = { total_count: 0, check_runs: [] }
  assert.equal(await client.checks('abc'), null)
})
