import assert from 'node:assert/strict'
import { test } from 'node:test'
import { samePath } from '../src/agents/paths.js'

test('samePath ignore la casse et les séparateurs là où le système les ignore', () => {
  // Le cwd d'un transcript écrit depuis le terminal de VS Code, face au chemin du projet.
  assert.ok(samePath('c:\\Users\\bob\\proj', 'C:\\Users\\bob\\proj', 'win32'))
  assert.ok(samePath('C:/Users/Bob/proj/', 'C:\\Users\\bob\\proj', 'win32'))
  assert.ok(samePath('C:\\', 'c:/', 'win32'))
  assert.ok(!samePath('C:\\Users\\bob\\proj', 'C:\\Users\\bob\\proj2', 'win32'))
  assert.ok(!samePath('C:\\Users\\bob\\proj', 'C:\\Users\\bob', 'win32'))

  assert.ok(samePath('/Users/Bob/Proj', '/users/bob/proj/', 'darwin'))
  assert.ok(samePath('/Users/bob/caf\u00e9', '/Users/bob/cafe\u0301', 'darwin'))

  // Linux distingue la casse : deux dossiers différents peuvent coexister.
  assert.ok(!samePath('/home/bob/Proj', '/home/bob/proj', 'linux'))
  assert.ok(samePath('/home/bob/proj/', '/home/bob/proj', 'linux'))
  assert.ok(samePath('/', '/', 'linux'))
})
