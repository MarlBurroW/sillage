import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { DEFAULT_CLAUDE_CONFIG, type SillageEvent } from '@sillage/protocol'
import { ClaudeRunner } from '../agents/claude/runner.js'
import type { RunnerContext } from '../agents/types.js'

/**
 * Sonde du repli d'un message dans le tour en cours, côté Claude.
 *
 * Rien de ce qu'elle vérifie n'est documenté : le champ `priority` de `SDKUserMessage`
 * est exporté sans commentaire, et la page « Streaming Input » décrit encore une file
 * strictement séquentielle. Le comportement est donc relevé plutôt que déduit, et cette
 * sonde est ce qui permettra de le revérifier au prochain bump du SDK.
 *
 * Le scénario tient à l'occupation du CLI : trois commandes lentes lui donnent des
 * frontières de lot d'outils, seuls moments où un message poussé peut être replié. Le
 * steer part pendant la première, et ce qu'on lit ensuite tranche entre les deux
 * comportements possibles. Un seul `turn.completed` dit que le message a rejoint le
 * tour ouvert ; deux disent qu'il a attendu le suivant, ce que la file fait déjà.
 *
 * Ne remplace pas un test : elle lance un vrai CLI authentifié et coûte un vrai tour
 * de modèle. Elle se lance à la main, quand on touche à ce chemin.
 */

const MARKER = 'PINEAPPLE'

const TASK = [
  'Run these three commands with Bash, one at a time, in order:',
  '`sleep 6 && echo STEP1`, then `sleep 6 && echo STEP2`, then `sleep 6 && echo STEP3`.',
  'When all three are done, reply with exactly FINISHED and nothing else.',
].join(' ')

const STEER = `Drop the remaining commands and reply with exactly ${MARKER} and nothing else.`

interface Trace {
  events: SillageEvent[]
  text: () => string
  count: (type: SillageEvent['type']) => number
}

function buildTrace(events: SillageEvent[]): Trace {
  return {
    events,
    text: () =>
      events
        .filter((event) => event.type === 'message.completed' && event.role === 'assistant')
        .flatMap((event) => (event.type === 'message.completed' ? event.blocks : []))
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join(' '),
    count: (type) => events.filter((event) => event.type === type).length,
  }
}

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Attend la fin du tour plutôt qu'une durée fixe : le CLI n'est pas régulier. */
async function waitForIdle(isIdle: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (isIdle()) return true
    await settle(500)
  }
  return false
}

async function main(): Promise<void> {
  const events: SillageEvent[] = []
  const trace = buildTrace(events)
  let status = 'idle'

  const ctx: RunnerContext = {
    conversationId: 'probe-steer',
    cwd: tmpdir(),
    // `bypassPermissions` : la sonde ne peut répondre à aucune demande d'approbation,
    // et trois `sleep` dans un répertoire temporaire ne demandent pas d'arbitrage.
    config: { ...DEFAULT_CLAUDE_CONFIG, permissionMode: 'bypassPermissions' },
    binary: process.env.CLAUDE_BIN ?? 'claude',
    attachmentsRoot: tmpdir(),
    resumeSessionId: null,
    projectOverview: () => null,
    resolveMcpServers: () => ({ servers: [], failures: [] }),
    emit: (event) => events.push(event),
    setStatus: (next) => {
      status = next
    },
    setAgentSessionId: () => {},
    updateConfig: () => {},
    openPermissionRequest: () => randomUUID(),
    closePermissionRequest: () => {},
  }

  const runner = new ClaudeRunner(ctx)
  await runner.start()
  await runner.send(TASK, [], [], [])

  // Assez tard pour que le tour soit ouvert et le premier outil lancé, assez tôt pour
  // qu'il reste deux commandes, donc deux frontières où le repli peut avoir lieu.
  await settle(8000)

  const steered = await runner.steer(STEER, [], [], [])
  console.log(`steer accepté : ${steered}`)

  const finished = await waitForIdle(() => status === 'idle', 120_000)
  await runner.stop()

  if (!finished) {
    console.log('ECHEC le tour ne s\'est pas terminé dans le temps imparti')
    return
  }

  const completed = trace.count('turn.completed')
  const tools = trace.count('tool.started')
  const marked = trace.text().includes(MARKER)

  console.log(`turn.started : ${trace.count('turn.started')}`)
  console.log(`turn.completed : ${completed}`)
  console.log(`appels d'outil : ${tools}`)
  console.log(`${MARKER} dans la réponse : ${marked}`)

  if (completed === 1 && marked) {
    console.log(`OK replié dans le tour ouvert, le CLI s'est arrêté après ${tools} des 3 commandes`)
  } else if (completed > 1 && marked) {
    console.log('ECHEC le message a ouvert son propre tour : la file suffisait')
  } else {
    console.log('ECHEC le message n\'est pas arrivé au modèle')
  }
}

await main()
process.exit(0)
