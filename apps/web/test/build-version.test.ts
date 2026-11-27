import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseBuildVersion } from '../src/lib/build-version'

test('a release build reads as its tag, with notes', () => {
  assert.deepEqual(parseBuildVersion('0.45.0'), { label: 'v0.45.0', detail: null, release: true })
  assert.deepEqual(parseBuildVersion('v0.46.0-rc.1'), { label: 'v0.46.0-rc.1', detail: null, release: true })
})

test('a build past its tag splits off the commit count and hash', () => {
  assert.deepEqual(parseBuildVersion('v0.45.0-12-gabc1234'), { label: 'v0.45.0', detail: '+12 · abc1234', release: false })
  assert.deepEqual(parseBuildVersion('v0.45.0-3-g0fa44ba7-dirty'), { label: 'v0.45.0', detail: '+3 · 0fa44ba7', release: false })
})

test('a dirty tag or a bare hash is no release', () => {
  assert.equal(parseBuildVersion('v0.45.0-dirty').release, false)
  assert.deepEqual(parseBuildVersion('abc1234'), { label: 'abc1234', detail: null, release: false })
  assert.deepEqual(parseBuildVersion('dev'), { label: 'dev', detail: null, release: false })
})
