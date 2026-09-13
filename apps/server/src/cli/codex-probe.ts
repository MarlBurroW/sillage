import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CODEX_CONFIG, type SillageEvent } from '@sillage/protocol'
import { CodexRunner } from '../agents/codex/runner.js'

/** Sonde manuelle : un vrai tour court sur le compte Codex, jamais exécuté en CI. */
const cwd = await mkdtemp(join(tmpdir(), 'sillage-codex-probe-'))
const blocking = process.argv.includes('--blocking')
const events: SillageEvent[] = []
let answered = false
let answering: Promise<boolean> | null = null
let finish: () => void = () => {}
const completed = new Promise<void>((resolve) => { finish = resolve })
const runner = new CodexRunner({
  conversationId: 'codex-probe', cwd, attachmentsRoot: cwd,
  binary: process.env.CODEX_BIN ?? 'codex', resumeSessionId: null,
  config: { ...DEFAULT_CODEX_CONFIG, model: process.env.CODEX_MODEL ?? 'gpt-6-astra',
    reasoningEffort: 'low', collaborationMode: blocking ? 'plan' : 'default',
    sandbox: 'read-only', askForApproval: 'never', sillageMcp: false },
  projectOverview: () => null, resolveMcpServers: () => ({ servers: [], failures: [] }),
  setAgentSessionId: () => {}, updateConfig: () => {},
  openPermissionRequest: () => 'probe-permission', closePermissionRequest: () => {},
  setStatus: (status) => { console.log(`status: ${status}`) },
  emit: (event) => {
    events.push(event)
    // Aucune sortie native ni donnée du compte : seulement le résultat de la sonde.
    if (!event.type.endsWith('.delta')) console.log(event.type, event.type === 'agent.notice' ? event.code : '')
    if (event.type === 'question.requested') {
      answering = runner.answerQuestion(event.requestId, {
        status: 'answered', decidedBy: null,
        answers: Object.fromEntries(event.questions.map((question) => [question.id, ['Vert']])),
      }).then((ok) => { answered = ok; return ok })
    }
    if (event.type === 'turn.completed' || event.type === 'error') finish()
  },
})

const timeout = setTimeout(() => { console.error('La sonde Codex a dépassé 90 secondes.'); finish() }, 90_000)
try {
  await runner.start()
  await runner.send(
    'Test d’intégration uniquement. Ne lis ni ne modifie aucun fichier et ne délègue rien. ' +
    `Utilise ${blocking ? 'request_user_input' : 'request_user_input_async'} pour me demander « Quelle couleur ? », avec les options Bleu et Vert. ` +
    'Attends ma réponse, puis réponds exactement « Reçu : Vert ».',
    [], [], [],
  )
  await completed
  if (answering) await answering
  assert.ok(answered, 'La question structurée doit avoir reçu sa réponse via le runner.')
  assert.ok(events.some((event) => event.type === 'question.requested' && event.blocking === blocking), 'Le formulaire doit respecter le mode demandé.')
  assert.ok(events.some((event) => event.type === 'message.completed' && event.role === 'assistant' &&
    event.blocks.some((block) => block.type === 'text' && block.text.includes('Reçu : Vert'))), 'Le modèle doit confirmer la réponse reçue.')
  assert.ok(!events.some((event) => event.type === 'agent.notice' && event.code === 'translation_failed'))
  assert.ok(events.some((event) => event.type === 'turn.completed' && event.inputTokens + event.cacheReadTokens > 0), 'La consommation du tour doit être comptée.')
  console.log(`OK : question ${blocking ? 'bloquante' : 'asynchrone'}, réponse transmise, confirmation et consommation du CLI.`)
} finally {
  clearTimeout(timeout)
  await runner.stop()
  await rm(cwd, { recursive: true, force: true })
}
