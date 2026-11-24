import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { threadOf, workflowAgentThread } from '@sillage/protocol/chat-state'
import { readWorkflowAgentThread } from '../src/agents/claude/workflow-threads.js'

/** Workflow agents' threads come from their transcripts, folded once and then only what was appended. */

const line = (entry: unknown) => JSON.stringify(entry) + '\n'
const at = (second: number) => new Date(Date.UTC(2026, 10, 24, 12, 0, second)).toISOString()

test('a workflow agent thread is read from its transcript, followed as it grows, and answered by version', async (t) => {
  const config = await mkdtemp(join(tmpdir(), 'sillage-wf-threads-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = config
  t.after(async () => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(config, { recursive: true, force: true })
  })
  const cwd = '/srv/project'
  const dir = join(config, 'projects', '-srv-project', 'session-1', 'subagents', 'workflows', 'wf_abc')
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'agent-a1.jsonl')
  await writeFile(file, [
    line({ type: 'user', uuid: 'u1', timestamp: at(0), isSidechain: true, message: { role: 'user', content: '[Workflow harness — computed task] Preamble. The computed task text follows:\n  Read the spec.\n  Then report.' } }),
    line({ type: 'assistant', timestamp: at(1), message: { id: 'm1', model: 'claude-haiku-5-5', content: [{ type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: '/srv/project/SPEC.md' } }] } }),
    line({ type: 'user', timestamp: at(2), message: { content: [{ type: 'tool_result', tool_use_id: 'read-1', content: 'x'.repeat(40_000) }] } }),
  ].join(''))

  const first = await readWorkflowAgentThread(cwd, 'session-1', 'a1', 100)
  assert.equal(first.unchanged, false)
  if (first.unchanged || !first.items) throw new Error('expected a thread')
  const prompt = first.items[0]
  assert.ok(prompt?.kind === 'message' && prompt.role === 'user')
  // The harness wrapping is gone, the script's indentation too.
  assert.deepEqual(prompt.blocks, [{ type: 'text', text: 'Read the spec.\nThen report.' }])
  const read = first.items.find((item) => item.kind === 'tool')
  assert.ok(read?.kind === 'tool' && read.status === 'done')
  assert.equal(threadOf(read), workflowAgentThread('a1'))
  assert.ok(typeof read.output === 'string' && read.output.length < 17_000)

  // Nothing new: the version alone answers.
  assert.deepEqual(await readWorkflowAgentThread(cwd, 'session-1', 'a1', 100, first.version), { unchanged: true, version: first.version })

  await appendFile(file, line({ type: 'assistant', timestamp: at(3), message: { id: 'm2', content: [{ type: 'text', text: 'Spec read.' }] } }))
  const grown = await readWorkflowAgentThread(cwd, 'session-1', 'a1', 100, first.version)
  if (grown.unchanged || !grown.items) throw new Error('expected the appended message')
  assert.ok(grown.version > first.version)
  assert.equal(grown.items.length, first.items.length + 1)

  // The tail only, with a count of what came before.
  const tail = await readWorkflowAgentThread(cwd, 'session-1', 'a1', 1)
  if (tail.unchanged || !tail.items) throw new Error('expected a tail')
  assert.equal(tail.items.length, 1)
  assert.equal(tail.earlier, grown.items.length - 1)

  assert.deepEqual(await readWorkflowAgentThread(cwd, 'session-1', 'missing', 100), { unchanged: false, items: null, earlier: 0, version: 0 })
  assert.deepEqual(await readWorkflowAgentThread(cwd, 'session-1', '../escape', 100), { unchanged: false, items: null, earlier: 0, version: 0 })
})
