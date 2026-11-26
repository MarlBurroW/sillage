import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parentOf, siblingPath } from '../src/lib/entries'
import { decodeScope, encodeScope, workspaceApiBase } from '../src/lib/workspace-scope'

test('every scope kind round-trips and routes to its own API', () => {
  const expected = {
    conversation: '/api/conversations/x',
    project: '/api/projects/x',
    personal: '/api/personal-workspaces/x',
    folder: '/api/explorer-folders/x',
    'project-folder': '/api/project-folders/x',
  } as const
  for (const [kind, base] of Object.entries(expected) as [keyof typeof expected, string][]) {
    const scope = encodeScope(kind, 'x')
    assert.deepEqual(decodeScope(scope), { kind, id: 'x' })
    assert.equal(workspaceApiBase(scope), base)
  }
})

test('conversation scopes stay bare IDs so existing tabs and caches keep working', () => {
  assert.equal(encodeScope('conversation', 'abc'), 'abc')
  // `project-folder:` must not be read as a `project:` scope with a `-folder:` prefix in the ID.
  assert.deepEqual(decodeScope('project-folder:42'), { kind: 'project-folder', id: '42' })
  // Only the first prefix is the kind: IDs may contain colons.
  assert.deepEqual(decodeScope('project:a:b'), { kind: 'project', id: 'a:b' })
})

test('entry paths rename within their own directory', () => {
  assert.equal(parentOf('src/lib/a.ts'), 'src/lib')
  assert.equal(parentOf('a.ts'), '')
  assert.equal(siblingPath('src/lib/a.ts', 'b.ts'), 'src/lib/b.ts')
  assert.equal(siblingPath('a.ts', 'b.ts'), 'b.ts')
})
