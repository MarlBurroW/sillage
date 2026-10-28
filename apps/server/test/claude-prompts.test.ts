import assert from 'node:assert/strict'
import { test } from 'node:test'
import { toSkippedInput } from '../src/agents/claude/prompts.js'

const input = {
  questions: [
    { question: 'Which color?', header: 'Color', multiSelect: false, options: [{ label: 'Red', description: '' }] },
    { question: 'Which size?', header: 'Size', multiSelect: false, options: [] },
  ],
}

test('une question ignorée est annotée « skipped » pour chaque intitulé, sans réponse', () => {
  const skipped = toSkippedInput(input)
  assert.deepEqual(skipped.answers, {})
  assert.deepEqual(skipped.annotations, {
    'Which color?': { unanswered: 'skipped' },
    'Which size?': { unanswered: 'skipped' },
  })
  assert.equal(skipped.questions, input.questions)
})
