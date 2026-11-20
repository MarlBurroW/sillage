import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CODEX_CONFIG, type SillageEvent } from '@sillage/protocol'
import { CodexRunner } from '../agents/codex/runner.js'

/**
 * Manual real-turn probe, never CI: a sub-agent's tokens must reach Sillage as `usage.consumed`,
 * equal to the totals Codex writes in the sub-agent's own rollout.
 */
const cwd = await mkdtemp(join(tmpdir(), 'sillage-codex-subagent-'))
const events: SillageEvent[] = []
const children: string[] = []
let finish: () => void = () => {}
const completed = new Promise<void>((resolve) => { finish = resolve })
const runner = new CodexRunner({
  conversationId: 'codex-subagent-probe', cwd, attachmentsRoot: cwd,
  binary: process.env.CODEX_BIN ?? 'codex', resumeSessionId: null,
  config: { ...DEFAULT_CODEX_CONFIG, model: process.env.CODEX_MODEL ?? 'gpt-6-luna',
    reasoningEffort: 'low', sandbox: 'read-only', askForApproval: 'never', sillageMcp: false },
  projectOverview: () => null, maskedInstructionRoots: () => [], memoryDir: () => null, resolveMcpServers: () => ({ servers: [], failures: [] }), skillRoots: () => [],
  setAgentSessionId: () => {}, updateConfig: () => {},
  openPermissionRequest: () => 'probe-permission', closePermissionRequest: () => {},
  setStatus: () => {},
  emit: (event) => {
    events.push(event)
    if (event.type === 'task.started' && event.kind === 'agent') children.push(event.taskId)
    if (event.type === 'usage.consumed' || event.type === 'turn.completed') console.log(JSON.stringify(event))
    if (event.type === 'turn.completed' || event.type === 'error') finish()
  },
})

/** Last cumulative totals Codex wrote for a thread, from its rollout under ~/.codex/sessions. */
async function rolloutTotals(threadId: string) {
  const root = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'sessions')
  const files = (await readdir(root, { recursive: true })).filter((file) => file.endsWith(`${threadId}.jsonl`))
  assert.equal(files.length, 1, `Rollout introuvable pour ${threadId}`)
  const lines = (await readFile(join(root, files[0]!), 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line))
  return lines.filter((line) => line.payload?.type === 'token_count' && line.payload.info).at(-1)?.payload.info.total_token_usage
}

const timeout = setTimeout(() => { console.error('La sonde a dépassé 4 minutes.'); finish() }, 240_000)
try {
  await runner.start()
  await runner.send(
    'Integration test only. Do not read or modify files. Spawn exactly one sub-agent and ask it to reply with the word "pong" and nothing else. ' +
    'Wait for its answer, then reply exactly "Sub-agent said: pong".',
    [], [], [],
  )
  await completed
  // A sub-agent may settle just after its parent's turn.
  await new Promise((resolve) => setTimeout(resolve, 5_000))
  const consumed = events.filter((event) => event.type === 'usage.consumed')
  assert.ok(children.length > 0, 'Le modèle devait lancer un sous-agent.')
  assert.ok(consumed.length > 0, 'La consommation du sous-agent doit être émise.')
  const recorded = consumed.reduce((sum, event) => ({
    input: sum.input + event.inputTokens + event.cacheReadTokens + event.cacheCreationTokens,
    output: sum.output + event.outputTokens,
  }), { input: 0, output: 0 })
  let native = { input: 0, output: 0 }
  for (const id of new Set(children)) {
    const totals = await rolloutTotals(id)
    native = { input: native.input + (totals?.input_tokens ?? 0), output: native.output + (totals?.output_tokens ?? 0) }
  }
  console.log(`Sous-agents : ${new Set(children).size} ; Sillage ${JSON.stringify(recorded)} ; rollouts ${JSON.stringify(native)}`)
  assert.deepEqual(recorded, native, 'Sillage doit compter ce que Codex a écrit pour ses sous-agents.')
  console.log('OK : consommation des sous-agents identique aux rollouts Codex.')
} finally {
  clearTimeout(timeout)
  await runner.stop()
  await rm(cwd, { recursive: true, force: true })
}
