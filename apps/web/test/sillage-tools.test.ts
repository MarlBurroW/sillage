import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registeredActionIdOf, scheduledTaskIdOf } from '../src/lib/sillage-tools'

const ID = '0b5f1c2e-7d3a-4e8f-9a1b-2c3d4e5f6a7b'

test('a scheduled task is found in English replies and in older French ones', () => {
  assert.equal(scheduledTaskIdOf(`Scheduled task “Nightly” created, id ${ID}.`), ID)
  assert.equal(scheduledTaskIdOf(`Tâche planifiée « Nightly » créée, id ${ID}.`), ID)
  assert.equal(scheduledTaskIdOf('Invalid parameters'), null)
})

test('a registered action is found in the creation reply, or in the input of an update', () => {
  assert.equal(registeredActionIdOf({ label: 'Tests' }, `Action “Tests” (task, id ${ID}) proposed. It appears in the Actions panel.`), ID)
  assert.equal(registeredActionIdOf({ id: ID, command: 'pnpm test' }, 'Action “Tests” updated.'), ID)
  assert.equal(registeredActionIdOf({ id: 'not-an-id' }, 'No action `not-an-id` in this project.'), null)
  assert.equal(registeredActionIdOf(null, null), null)
})
