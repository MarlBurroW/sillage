import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { claimSystemSkills, releaseSystemSkills, removeMaterializedSystemSkills } from '../src/agents/antigravity/system-skills.js'

/** Antigravity's `skills/system/` must not outlive its sessions in a project folder (card #74). */

// The file Antigravity 1.4.3 writes at session/new, reduced to its frontmatter.
const SYSTEM_SKILL = "---\nname: run-workflow\ndescription: 'How to run a workflow.'\nmetadata:\n    namespace: system\n---\n# Dynamic workflows\n"

function workspace(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), 'sillage-ag-skills-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), content)
}

test('the materialized system skill and its emptied folders are removed', (t) => {
  const cwd = workspace(t)
  write(cwd, 'skills/system/run-workflow/SKILL.md', SYSTEM_SKILL)
  assert.deepEqual(removeMaterializedSystemSkills(cwd), ['run-workflow'])
  assert.equal(existsSync(join(cwd, 'skills')), false)
})

test("the user's own skills, and skills without the system namespace, stay", (t) => {
  const cwd = workspace(t)
  write(cwd, 'skills/system/run-workflow/SKILL.md', SYSTEM_SKILL)
  write(cwd, 'skills/system/mine/SKILL.md', '---\nname: mine\ndescription: Mine.\n---\n')
  write(cwd, 'skills/deploy/SKILL.md', '---\nname: deploy\ndescription: Deploy.\n---\n')
  assert.deepEqual(removeMaterializedSystemSkills(cwd), ['run-workflow'])
  assert.equal(existsSync(join(cwd, 'skills/system/mine/SKILL.md')), true)
  assert.equal(existsSync(join(cwd, 'skills/deploy/SKILL.md')), true)
})

test('a system skill committed to the repository is never deleted', (t) => {
  const cwd = workspace(t)
  const git = (...args: string[]) => execFileSync('git', args, { cwd, stdio: 'ignore', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } })
  git('init', '-q')
  write(cwd, 'skills/system/run-workflow/SKILL.md', SYSTEM_SKILL)
  git('add', '-A')
  assert.deepEqual(removeMaterializedSystemSkills(cwd), [])
  assert.equal(existsSync(join(cwd, 'skills/system/run-workflow/SKILL.md')), true)
})

test('a folder without materialized skills is left untouched', (t) => {
  const cwd = workspace(t)
  assert.deepEqual(removeMaterializedSystemSkills(cwd), [])
  mkdirSync(join(cwd, 'skills'))
  assert.deepEqual(removeMaterializedSystemSkills(cwd), [])
  assert.equal(existsSync(join(cwd, 'skills')), true)
})

test('only the last Antigravity session leaving a folder cleans it', (t) => {
  const cwd = workspace(t)
  write(cwd, 'skills/system/run-workflow/SKILL.md', SYSTEM_SKILL)
  claimSystemSkills(cwd)
  claimSystemSkills(cwd)
  releaseSystemSkills(cwd)
  // The other session may still read the skill.
  assert.equal(existsSync(join(cwd, 'skills/system/run-workflow/SKILL.md')), true)
  releaseSystemSkills(cwd)
  assert.equal(existsSync(join(cwd, 'skills')), false)
  // A release without a claim does nothing.
  write(cwd, 'skills/system/run-workflow/SKILL.md', SYSTEM_SKILL)
  releaseSystemSkills(cwd)
  assert.equal(existsSync(join(cwd, 'skills/system/run-workflow/SKILL.md')), true)
})
