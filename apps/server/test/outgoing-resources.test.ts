import assert from 'node:assert/strict'
import { test } from 'node:test'
import { describeOutgoingMessage } from '../src/agents/outgoing.js'

const mention = (relativePath: string) => ({ relativePath, path: `/w/${relativePath}`, name: relativePath })

test('message journalisé : mentions, skills et commande connue, seulement s\'ils figurent dans le texte', () => {
  const { blocks } = describeOutgoingMessage('/review regarde @go.mod avec $lint', [], null, {
    mentions: [mention('go.mod'), mention('gone.txt')],
    skills: ['lint', 'removed'],
    commands: ['review', 'init'],
  })
  assert.deepEqual(blocks, [{ type: 'text', text: '/review regarde @go.mod avec $lint', mentions: ['go.mod'], skills: ['lint'], command: 'review' }])

  // An unknown command, a path or nothing attached: a plain text block, as before.
  assert.deepEqual(describeOutgoingMessage('/etc/hosts est cassé', [], null, { commands: ['review'] }).blocks,
    [{ type: 'text', text: '/etc/hosts est cassé' }])
  assert.deepEqual(describeOutgoingMessage('bonjour', []).blocks, [{ type: 'text', text: 'bonjour' }])
})
