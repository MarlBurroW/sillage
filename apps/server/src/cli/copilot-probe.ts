import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_COPILOT_CONFIG, sillageEventSchema, type SillageEvent } from '@sillage/protocol'
import { CopilotRunner } from '../agents/copilot/runner.js'
import type { RunnerContext } from '../agents/types.js'

/**
 * Manual probe of the installed GitHub Copilot CLI with two real turns, never CI: each turn spends
 * the signed-in account's requests (Auto counts as one). Checks an edit behind a permission, the
 * instruction channel, then a resume through `session/load` that must not journal the replay.
 * Sessions stay in `~/.copilot`; the IDs are printed for cleanup.
 */
const cwd = await mkdtemp(join(tmpdir(), 'sillage-copilot-probe-'))
await writeFile(join(cwd, 'note.txt'), 'hello\n')

function context(events: SillageEvent[], resumeSessionId: string | null, onSession: (id: string) => void, done: () => void, runner: () => CopilotRunner): RunnerContext {
  return {
    conversationId: 'copilot-probe', cwd, attachmentsRoot: cwd,
    binary: process.env.COPILOT_BIN ?? 'copilot', resumeSessionId,
    config: { ...DEFAULT_COPILOT_CONFIG, model: process.env.COPILOT_MODEL ?? 'auto', sillageMcp: false, skillLibrary: false },
    projectOverview: () => 'The project codename is ZEPHYR-9.', maskedInstructionRoots: () => [], memoryDir: () => null,
    resolveMcpServers: () => ({ servers: [], failures: [] }), skillRoots: () => [],
    setAgentSessionId: onSession, updateConfig: () => {},
    openPermissionRequest: () => `probe-permission-${events.length}`, closePermissionRequest: () => {},
    setStatus: (status) => { console.log(`status: ${status}`) },
    emit: (event) => {
      events.push(sillageEventSchema.parse(event))
      if (!event.type.endsWith('.delta')) console.log(event.type, event.type === 'tool.started' ? `${event.name} ${JSON.stringify(event.input).slice(0, 120)}` : event.type === 'agent.notice' ? event.code : '')
      if (event.type === 'permission.requested') setImmediate(() => runner().resolvePermission(event.requestId, { decision: 'allowed', scope: 'once', decidedBy: null }))
      if (event.type === 'turn.completed' || event.type === 'error') done()
    },
  }
}

async function turn(resume: string | null, prompt: string): Promise<{ events: SillageEvent[]; sessionId: string }> {
  const events: SillageEvent[] = []
  let sessionId = ''
  let finish: () => void = () => {}
  const completed = new Promise<void>((resolve) => { finish = resolve })
  const runner: CopilotRunner = new CopilotRunner(context(events, resume, (id) => { sessionId = id }, () => finish(), () => runner))
  const timeout = setTimeout(() => { console.error('The Copilot probe exceeded 180 seconds.'); finish() }, 180_000)
  try {
    await runner.start()
    await runner.send(prompt, [], [], [])
    await completed
  } finally {
    clearTimeout(timeout)
    await runner.stop()
  }
  return { events, sessionId }
}

try {
  const first = await turn(null, 'Integration test. With your file editing tool, not the shell, append the line "world" to note.txt, then reply with exactly: Done ZEPHYR-9 (replace ZEPHYR-9 by the project codename from your instructions).')
  assert.equal(await readFile(join(cwd, 'note.txt'), 'utf8'), 'hello\nworld\n', 'The edit must have happened.')
  assert.ok(first.events.some((event) => event.type === 'permission.requested' && event.toolName === 'Edit'), 'The edit must ask for permission.')
  assert.ok(first.events.some((event) => event.type === 'file.edited' && event.path === 'note.txt' && event.action === 'modified'))
  assert.ok(first.events.some((event) => event.type === 'message.completed' && event.role === 'assistant' && event.blocks.some((block) => block.type === 'text' && block.text.includes('ZEPHYR-9'))), 'The instructions file must be read.')
  assert.ok(first.events.some((event) => event.type === 'turn.completed' && event.stopReason === 'completed' && event.inputTokens > 0), 'Turn usage must be counted.')

  const second = await turn(first.sessionId, 'Which line did you append to note.txt? Reply with the line only.')
  assert.equal(second.sessionId, first.sessionId, 'The resume must keep the session.')
  assert.ok(!second.events.some((event) => event.type === 'tool.started'), 'The replayed history must not be journaled again.')
  assert.ok(second.events.some((event) => event.type === 'message.completed' && event.role === 'assistant' && event.blocks.some((block) => block.type === 'text' && block.text.includes('world'))), 'The resumed session must remember the first turn.')
  console.log(`OK: turn, permission, edit, instructions, usage and resume. Session to delete: ${first.sessionId}`)
} finally {
  await rm(cwd, { recursive: true, force: true })
}
