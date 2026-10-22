import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { readSubAgentTranscripts, readTranscript, transcriptPath } from '../src/agents/claude/transcript.js'

test('la relecture ignore le rejeu API sans perdre les messages ni les sous-agents', async () => {
  const data = await mkdtemp(join(tmpdir(), 'sillage-transcript-'))
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = data
  try {
    const file = transcriptPath('/workspace', 'session')
    await mkdir(dirname(file), { recursive: true })
    const message = { type: 'user', message: { content: [{ type: 'api-request-blob' }] } }
    const spawn = { type: 'user', toolUseResult: { agentId: 'child' }, message: { content: [{ type: 'tool_result', tool_use_id: 'call' }] } }
    const replay = [
      { type: 'api-request-shape', shape: { system: 'x'.repeat(2_000_000) } },
      { type: 'api-request-blob', message: { content: 'duplicate' } },
      { sessionId: 'session', type: 'api-request', params: {} },
    ]
    await writeFile(file, [message, ...replay, spawn].map(x => JSON.stringify(x)).join('\r\n') + '\n{"type":')
    assert.deepEqual(await readTranscript('/workspace', 'session'), [message, spawn])
    assert.deepEqual(await readTranscript('/workspace', 'missing'), [])
    const childDir = join(file.replace(/\.jsonl$/, ''), 'subagents')
    await mkdir(childDir, { recursive: true })
    // The final valid line counts even before the CLI writes its newline.
    await writeFile(join(childDir, 'agent-child.jsonl'), [...replay, message].map(x => JSON.stringify(x)).join('\n'))
    const threads = await readSubAgentTranscripts('/workspace', 'session', [spawn])
    assert.deepEqual(threads.get('call'), [message])
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    await rm(data, { recursive: true, force: true })
  }
})
