import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_OPENCODE_CONFIG, sillageEventSchema, type SillageEvent } from '@sillage/protocol'
import { OpencodeRunner } from '../agents/opencode/runner.js'

/**
 * Sonde manuelle : un vrai tour sur l'opencode installé, jamais exécutée en CI.
 *
 * Le modèle gratuit `opencode/big-pickle` suffit, sans identifiant de fournisseur. La
 * session créée reste dans la base d'opencode du poste : la sonde affiche son
 * identifiant, à supprimer avec `opencode session delete <id>`.
 */
const cwd = await mkdtemp(join(tmpdir(), 'sillage-opencode-probe-'))
await writeFile(join(cwd, 'note.txt'), 'hello\n')

const events: SillageEvent[] = []
let sessionId = ''
let finish: () => void = () => {}
const completed = new Promise<void>((resolve) => { finish = resolve })
const runner = new OpencodeRunner({
  conversationId: 'opencode-probe', cwd, attachmentsRoot: cwd,
  binary: process.env.OPENCODE_BIN ?? join(homedir(), '.opencode/bin/opencode'), resumeSessionId: null,
  config: { ...DEFAULT_OPENCODE_CONFIG, model: process.env.OPENCODE_MODEL ?? 'opencode/big-pickle', sillageMcp: false },
  projectOverview: () => 'The project codename is ZEPHYR-9.', maskedInstructionRoots: () => [], memoryDir: () => null,
  resolveMcpServers: () => ({ servers: [], failures: [] }), skillRoots: () => [],
  setAgentSessionId: (id) => { sessionId = id }, updateConfig: () => {},
  openPermissionRequest: () => `probe-permission-${events.length}`, closePermissionRequest: () => {},
  setStatus: (status) => { console.log(`status: ${status}`) },
  emit: (event) => {
    events.push(sillageEventSchema.parse(event))
    // Aucune sortie native : seulement le résultat de la sonde.
    if (!event.type.endsWith('.delta')) {
      console.log(event.type, event.type === 'tool.started' ? event.name : event.type === 'agent.notice' ? event.code : '')
    }
    if (event.type === 'permission.requested') {
      setImmediate(() => runner.resolvePermission(event.requestId, { decision: 'allowed', scope: 'once', decidedBy: null }))
    }
    if (event.type === 'turn.completed' || event.type === 'error') finish()
  },
})

const timeout = setTimeout(() => { console.error('La sonde opencode a dépassé 120 secondes.'); finish() }, 120_000)
try {
  await runner.start()
  await runner.send(
    'Integration test. Use the edit tool to append the line "world" to note.txt, then reply with exactly: Done ZEPHYR-9 ' +
    '(replace ZEPHYR-9 by the project codename from your instructions).',
    [], [],
  )
  await completed
  assert.equal(await readFile(join(cwd, 'note.txt'), 'utf8'), 'hello\nworld\n', "L'édition doit avoir eu lieu.")
  assert.ok(events.some((event) => event.type === 'permission.requested' && event.toolName === 'Edit'), "L'édition doit demander la permission.")
  assert.ok(events.some((event) => event.type === 'tool.started' && event.name === 'Edit'), "L'outil doit porter son nom du journal.")
  assert.ok(events.some((event) => event.type === 'file.edited' && event.path === 'note.txt' && event.action === 'modified'))
  assert.ok(events.some((event) => event.type === 'message.completed' && event.role === 'assistant' &&
    event.blocks.some((block) => block.type === 'text' && block.text.includes('ZEPHYR-9'))), 'Le prompt système injecté doit être lu.')
  assert.ok(!events.some((event) => event.type === 'agent.notice' && event.code === 'translation_failed'))
  assert.ok(events.some((event) => event.type === 'turn.completed' && event.stopReason === 'completed' &&
    event.inputTokens + event.cacheReadTokens > 0), 'La consommation du tour doit être comptée.')
  console.log(`OK : tour, outil, permission, édition et consommation. Session à supprimer : ${sessionId}`)
} finally {
  clearTimeout(timeout)
  await runner.stop()
  await rm(cwd, { recursive: true, force: true })
}
