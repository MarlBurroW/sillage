import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SillageEvent } from '@sillage/protocol'

// Le fold est indépendant de React ; seul le choix initial de langue lit le navigateur.
Object.defineProperty(globalThis, 'localStorage', { value: { getItem: () => 'fr' }, configurable: true })
const { applyEvent, emptyChatState, isAwaitingUser } = await import('../../web/src/lib/chat-fold.js')

const fold = (events: SillageEvent[]) => events.reduce((state, event, index) =>
  applyEvent(state, index + 1, index * 100, event), emptyChatState())

test('rejeu : une question asynchrone garde ses choix sans bloquer l’activité', () => {
  const events: SillageEvent[] = [
    { type: 'turn.started' },
    { type: 'question.requested', requestId: 'async', blocking: false, questions: [{
      id: '0', header: '', question: 'Couleur ?', options: [{ label: 'Vert', description: '', preview: null }],
      allowOther: true, multiSelect: false, secret: false,
    }] },
    { type: 'message.delta', messageId: 'continuing', text: 'Je continue.', parentToolCallId: null },
  ]
  const state = fold(events)
  assert.equal(state.turnRunning, true)
  assert.equal(state.items.some(isAwaitingUser), false)
  const resolved = fold([...events, { type: 'question.resolved', requestId: 'async', status: 'answered', answers: { '0': ['Autre couleur'] }, decidedBy: 'user' }])
  const question = resolved.items.find((item) => item.kind === 'question')!
  assert.equal(question.kind, 'question')
  if (question.kind === 'question') assert.deepEqual(question.answers, { '0': ['Autre couleur'] })
})

test('anciens journaux bloquants et fin de plan faisant autorité sur les deltas', () => {
  const state = fold([
    { type: 'question.requested', requestId: 'old', questions: [] },
    { type: 'message.delta', messageId: 'plan', text: 'Draft', parentToolCallId: null },
    { type: 'message.completed', messageId: 'plan', role: 'assistant', blocks: [{ type: 'text', text: 'Final plan' }], parentToolCallId: null },
    { type: 'agent.notice', code: 'new-event', level: 'warning', message: 'Visible', details: { preserved: true } },
  ])
  assert.equal(state.items.some(isAwaitingUser), true)
  const message = state.items.find((item) => item.kind === 'message')!
  assert.ok(message.kind === 'message' && message.streamingText === '' && message.blocks[0]?.type === 'text' && message.blocks[0].text === 'Final plan')
  assert.ok(state.items.some((item) => item.kind === 'notice' && item.text === 'Visible' && item.details != null))
})

test('plans et diffs se mettent à jour sans doublon, les sorties restent visibles pendant un outil', () => {
  const events: SillageEvent[] = [
    { type: 'turn.started' },
    { type: 'plan.updated', items: [{ text: 'Inspecter', status: 'in_progress' }] },
    { type: 'plan.updated', items: [{ text: 'Inspecter', status: 'completed' }] },
    { type: 'diff.updated', files: [], patch: 'first patch' },
    { type: 'diff.updated', files: [], patch: 'final patch' },
    { type: 'tool.started', toolCallId: 'shell', name: 'Bash', input: { command: 'test' }, parentToolCallId: null },
    { type: 'tool.output_delta', toolCallId: 'shell', chunk: 'Starting\n' },
    { type: 'tool.output_delta', toolCallId: 'shell', chunk: 'Still running' },
  ]
  const state = fold(events)
  assert.equal(state.items.filter((item) => item.kind === 'plan_progress').length, 1)
  assert.ok(state.items.some((item) => item.kind === 'plan_progress' && item.items[0]?.status === 'completed'))
  assert.equal(state.items.filter((item) => item.kind === 'diff').length, 1)
  assert.ok(state.items.some((item) => item.kind === 'diff' && item.patch === 'final patch'))
  assert.ok(state.items.some((item) => item.kind === 'tool' && item.status === 'running' && item.output === 'Starting\nStill running'))
  const final = fold([...events, { type: 'tool.completed', toolCallId: 'shell', output: 'Final output', durationMs: 10, isError: false }])
  assert.ok(final.items.some((item) => item.kind === 'tool' && item.output === 'Final output'))
})
