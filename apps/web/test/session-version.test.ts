import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PREFERRED_CLI_RELEASES, type SillageEvent } from '@sillage/protocol'
import { applyEvent, emptyChatState } from '@sillage/protocol/chat-state'
import { sessionVersionGap } from '../src/lib/session-version'

const preferred = PREFERRED_CLI_RELEASES.claude.version
const started = (cliVersion?: string | null): SillageEvent =>
  ({ type: 'session.started', agent: 'claude', agentSessionId: 's', model: 'opus', cwd: '/', tools: [], cliVersion })

test('the fold keeps the version of the latest process, and forgets it when that process says nothing', () => {
  let state = applyEvent(emptyChatState(), 1, 1, started('2.1.300'))
  assert.equal(state.cliVersion, '2.1.300')
  state = applyEvent(state, 2, 2, started())
  assert.equal(state.cliVersion, null)
})

test('a session is flagged only when its version differs from the target', () => {
  assert.equal(sessionVersionGap('claude', preferred), null)
  assert.equal(sessionVersionGap('claude', null), null)
  assert.equal(sessionVersionGap('claude', undefined), null)
  assert.equal(sessionVersionGap('claude', 'not a version'), null)
  assert.match(sessionVersionGap('claude', '2.0.1') ?? '', new RegExp(`Older than ${preferred.replaceAll('.', '\\.')}`))
  assert.match(sessionVersionGap('claude', '99.0.0') ?? '', /Newer than/)
})
