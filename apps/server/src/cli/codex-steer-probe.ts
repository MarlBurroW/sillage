import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CODEX_CONFIG, type SillageEvent } from '@sillage/protocol'
import { CodexAppServerClient } from '../agents/codex/app-server-client.js'
import { CLIENT_INFO } from '../agents/codex/client-info.js'
import { CodexRunner } from '../agents/codex/runner.js'

/**
 * Sonde manuelle de `turn/steer` pendant que le modèle écrit sa réponse.
 *
 * Depuis 0.162.1, `instant_interrupt` est actif par défaut : le steer peut couper le
 * message en cours au lieu d'attendre la fin de l'item. Ce qui compte pour Sillage
 * (écho unique du message steeré, réponse coupée conservée, tour qui continue puis
 * repasse au repos) n'est décrit nulle part ; la sonde le relève sur le binaire
 * installé. Deux passes : `--raw` journalise la séquence app-server brute, sans
 * Sillage ; sans option, la même scène passe par le vrai `CodexRunner`.
 *
 * Un vrai tour de modèle par passe : à lancer à la main, jamais en CI.
 */

const raw = process.argv.includes('--raw')
const MARKER = 'PINEAPPLE'
const TASK =
  'Test d’intégration. Ne lis ni ne modifie aucun fichier et n’utilise aucun outil. ' +
  'Écris un long texte : les nombres de 1 à 400 en toutes lettres, un par ligne.'
const STEER = `Arrête la liste immédiatement et réponds exactement ${MARKER}, rien d’autre.`
// Assez de deltas pour être sûr d'être au milieu du message, pas à sa toute fin.
const DELTAS_BEFORE_STEER = 40

const binary = process.env.CODEX_BIN ?? 'codex'
const model = process.env.CODEX_MODEL ?? 'gpt-6-astra'
const cwd = await mkdtemp(join(tmpdir(), 'sillage-codex-steer-'))

/** Résume un paramètre de notification sans recopier de texte du modèle en entier. */
function summarize(method: string, params: any): string {
  const item = params?.item
  if (item) {
    const text = typeof item.text === 'string' ? ` text=${JSON.stringify(item.text.slice(0, 40))}…(${item.text.length})` : ''
    const content = Array.isArray(item.content) ? ` content=${JSON.stringify(item.content).slice(0, 120)}` : ''
    return `${method} ${item.type} id=${item.id}${text}${content}${item.phase ? ` phase=${item.phase}` : ''}`
  }
  if (params?.turn) return `${method} turn=${params.turn.id} status=${params.turn.status}${params.turn.error ? ` error=${JSON.stringify(params.turn.error)}` : ''}`
  if (params?.itemId) return `${method} item=${params.itemId}`
  return method
}

async function probeRaw(): Promise<void> {
  let deltas = 0
  let turnId: string | null = null
  let threadId: string | null = null
  let steered: Promise<unknown> | null = null
  let finish: () => void = () => {}
  const done = new Promise<void>((resolve) => { finish = resolve })
  const deltaRuns: string[] = []
  const client: CodexAppServerClient = new CodexAppServerClient({
    binary, cwd,
    onServerRequest: async () => ({ decision: 'decline' }),
    onNotification: (method, params: any) => {
      if (method.endsWith('/delta')) {
        // Les deltas sont regroupés par item : seul leur enchaînement nous intéresse.
        const key = `${method} item=${params.itemId}`
        if (deltaRuns.at(-1)?.startsWith(key)) {
          deltaRuns[deltaRuns.length - 1] = `${key} ×${Number(deltaRuns.at(-1)!.split('×')[1] ?? 1) + 1}`
        } else {
          deltaRuns.push(`${key} ×1`)
          console.log(`  ${key} (début)`)
        }
        if (method === 'item/agentMessage/delta' && ++deltas === DELTAS_BEFORE_STEER && turnId && threadId) {
          console.log(`>>> turn/steer après ${deltas} deltas`)
          steered = client.call('turn/steer', { threadId, expectedTurnId: turnId, input: [{ type: 'text', text: STEER, text_elements: [] }] })
            .then((result) => console.log('<<< turn/steer', JSON.stringify(result)), (error) => console.log('<<< turn/steer ERREUR', String(error)))
        }
        return
      }
      if (deltaRuns.length) { console.log(`  ${deltaRuns.at(-1)}`); deltaRuns.length = 0 }
      if (method === 'turn/started') turnId = params.turn.id
      console.log(summarize(method, params))
      if (method === 'turn/completed') finish()
    },
  })
  await client.initialize(CLIENT_INFO)
  const started: any = await client.call('thread/start', { cwd, approvalPolicy: 'never', sandbox: 'read-only', model })
  threadId = started.thread.id
  const turn: any = await client.call('turn/start', { threadId: threadId!, input: [{ type: 'text', text: TASK, text_elements: [] }], effort: 'low' } as any)
  turnId ??= turn.turn.id
  const timeout = setTimeout(() => { console.error('Délai de 180 s dépassé.'); finish() }, 180_000)
  await done
  clearTimeout(timeout)
  if (steered) await steered
  // Ce que le fil retient du tour : la réponse coupée y est-elle encore ?
  const read: any = await client.call('thread/read', { threadId: threadId!, includeTurns: true })
  for (const t of read.thread.turns ?? []) {
    console.log(`thread/read turn=${t.id} status=${t.status}`)
    for (const item of t.items ?? []) console.log(`  ${summarize('item', { item })}`)
  }
  client.close()
}

async function probeRunner(): Promise<void> {
  const events: SillageEvent[] = []
  const statuses: string[] = []
  let deltas = 0
  let steered: Promise<boolean> | null = null
  let finish: () => void = () => {}
  const done = new Promise<void>((resolve) => { finish = resolve })
  const runner: CodexRunner = new CodexRunner({
    conversationId: 'codex-steer-probe', cwd, attachmentsRoot: cwd, binary, resumeSessionId: null,
    config: { ...DEFAULT_CODEX_CONFIG, model, reasoningEffort: 'low', sandbox: 'read-only', askForApproval: 'never', sillageMcp: false },
    projectOverview: () => null, maskedInstructionRoots: () => [], memoryDir: () => null,
    resolveMcpServers: () => ({ servers: [], failures: [] }), skillRoots: () => [],
    setAgentSessionId: () => {}, updateConfig: () => {},
    openPermissionRequest: () => 'probe-permission', closePermissionRequest: () => {},
    setStatus: (status) => { statuses.push(status); console.log(`status: ${status}`) },
    emit: (event) => {
      events.push(event)
      if (event.type === 'message.delta') {
        if (++deltas === DELTAS_BEFORE_STEER) {
          console.log(`>>> steer après ${deltas} deltas`)
          steered = runner.steer(STEER, [], [], [])
        }
        return
      }
      if (event.type.endsWith('.delta')) return
      const detail = event.type === 'message.completed'
        ? `${event.role} ${event.messageId} ${JSON.stringify(event.blocks.map((b) => (b.type === 'text' ? b.text.slice(0, 40) + `…(${b.text.length})` : b.type)))}`
        : event.type === 'agent.notice' ? event.code : ''
      console.log(event.type, detail)
      if (event.type === 'turn.completed' || event.type === 'error') finish()
    },
  })
  const timeout = setTimeout(() => { console.error('Délai de 180 s dépassé.'); finish() }, 180_000)
  try {
    await runner.start()
    await runner.send(TASK, [], [], [])
    await done
    assert.ok(steered, 'Le steer doit être parti pendant la réponse.')
    assert.equal(await steered, true, 'Le CLI doit accepter le steer.')
    const users = events.filter((e) => e.type === 'message.completed' && e.role === 'user')
    assert.equal(users.length, 2, 'Le message initial et le steer, chacun une seule fois.')
    const assistant = events.filter((e) => e.type === 'message.completed' && e.role === 'assistant')
    const texts = assistant.map((e) => (e.type === 'message.completed' ? e.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('') : ''))
    assert.ok(texts.some((t) => !t.includes(MARKER) && t.length > 0), 'La réponse coupée doit rester dans le fil.')
    assert.ok(texts.some((t) => t.includes(MARKER)), 'Le tour doit continuer et suivre le steer.')
    assert.equal(events.filter((e) => e.type === 'turn.completed').length, 1, 'Un seul tour : le steer ne relance rien.')
    assert.equal(statuses.at(-1), 'idle', 'Le statut doit revenir au repos.')
    assert.ok(!events.some((e) => e.type === 'agent.notice' && e.code === 'translation_failed'))
    console.log('OK : steer pendant la réponse, écho unique, réponse coupée gardée, tour unique, retour au repos.')
  } finally {
    clearTimeout(timeout)
    await runner.stop()
  }
}

try {
  console.log(`codex : ${binary}, modèle ${model}, passe ${raw ? 'brute' : 'runner'}`)
  await (raw ? probeRaw() : probeRunner())
} finally {
  await rm(cwd, { recursive: true, force: true })
}
