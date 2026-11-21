import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SillageEvent } from '@sillage/protocol'
import { isUnder, toSlashPath } from '../src/agents/paths.js'
import { touchedPaths } from '../src/events/touched-paths.js'

/** Containment and separators per platform: hand-written `startsWith(parent + '/')` never matched a Windows path. */

test('a path under a directory is recognized with each platform’s own rules', () => {
  // Windows: either separator, any drive or letter case, as terminals and pickers report them.
  assert.equal(isUnder('C:\\Users\\me\\worktrees\\feat', 'C:\\Users\\me\\worktrees\\feat\\src\\a.ts', 'win32'), true)
  assert.equal(isUnder('C:\\Users\\me\\worktrees\\feat', 'c:/users/me/worktrees/feat/src/a.ts', 'win32'), true)
  assert.equal(isUnder('C:\\Users\\me\\worktrees\\feat', 'C:\\Users\\me\\worktrees\\feat', 'win32'), true)
  assert.equal(isUnder('C:\\Users\\me\\worktrees\\feat', 'C:\\Users\\me\\worktrees\\feature\\a.ts', 'win32'), false, 'a sibling sharing a prefix is not inside')
  // macOS ignores case; Linux does not.
  assert.equal(isUnder('/Users/me/Repo', '/users/me/repo/src', 'darwin'), true)
  assert.equal(isUnder('/home/me/Repo', '/home/me/repo/src', 'linux'), false)
  assert.equal(isUnder('/home/me/repo/', '/home/me/repo/src', 'linux'), true, 'a trailing separator changes nothing')
  assert.equal(isUnder('/', '/etc', 'linux'), true)
})

test('repository-relative paths use slashes on Windows only', () => {
  assert.equal(toSlashPath('src\\lib\\a.ts', 'win32'), 'src/lib/a.ts')
  // Elsewhere a backslash is a character of the file name.
  assert.equal(toSlashPath('odd\\name.txt', 'linux'), 'odd\\name.txt')
})

test('directories named in Bash commands are found in Windows and Git Bash forms', () => {
  const bash = (command: string): SillageEvent => ({ type: 'tool.started', toolCallId: 't', name: 'Bash', input: { command }, parentToolCallId: null })
  assert.deepEqual(touchedPaths(bash('cd "C:\\Users\\me\\worktrees\\feat" && git status'), 'win32'), ['C:\\Users\\me\\worktrees\\feat'])
  assert.deepEqual(touchedPaths(bash('git -C C:/Users/me/repo log'), 'win32'), ['C:/Users/me/repo'])
  // Git Bash writes the drive as a directory: it must name the same tree as its Windows path.
  const gitBash = touchedPaths(bash('cd /c/Users/me/worktrees/feat'), 'win32')
  assert.deepEqual(gitBash, ['C:/Users/me/worktrees/feat'])
  assert.equal(isUnder('C:\\Users\\me\\worktrees\\feat', gitBash[0]!, 'win32'), true)
  // POSIX forms are unchanged.
  assert.deepEqual(touchedPaths(bash('cd /home/me/repo/ && ls'), 'linux'), ['/home/me/repo'])
  assert.deepEqual(touchedPaths(bash('cd /c/data'), 'linux'), ['/c/data'], 'only Windows reads /c as a drive')
})
