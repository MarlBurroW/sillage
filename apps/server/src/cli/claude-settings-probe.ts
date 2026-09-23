import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { DEFAULT_CLAUDE_CONFIG, type SillageEvent } from '@sillage/protocol'
import { ClaudeRunner } from '../agents/claude/runner.js'
import type { RunnerContext } from '../agents/types.js'

/**
 * Sonde des réglages de session portés par la couche « flag » du CLI : style de
 * réponse, mode rapide, suggestions de message suivant.
 *
 * Rien de tout ça n'est documenté au-delà des types du SDK : `applyFlagSettings` est
 * annoncé « streaming input only », l'opt-in du mode rapide par le SDK
 * (`sdk_opt_in_required`) n'apparaît que dans une union de motifs, et les suggestions
 * n'arrivent qu'après le `result`. Le comportement est donc relevé plutôt que déduit,
 * et cette sonde est ce qui permettra de le revérifier au prochain bump du SDK.
 *
 * Deux tours minuscules. Le premier en vitesse normale et style `Concise` doit produire
 * un seul `session.started`, une suggestion et aucun avis de mode rapide. Le second,
 * après passage à chaud en mode rapide, doit produire l'avis « activé », ou nommer
 * l'empêchement que le compte oppose. Ne remplace pas un test : elle lance un vrai CLI
 * authentifié et coûte deux vrais tours, dont un au tarif du mode rapide, en crédits
 * d'usage. Elle se lance à la main, quand on touche à ce chemin.
 */

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForIdle(isIdle: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (isIdle()) return true
    await settle(500)
  }
  return false
}

function describe(event: SillageEvent): string | null {
  switch (event.type) {
    case 'session.started':
      return `session.started (${event.model})`
    case 'agent.notice':
      return `agent.notice ${event.code}${event.id ? ` [${event.id}]` : ''} : ${event.message}`
    case 'suggestion.updated':
      return `suggestion.updated : ${event.text}`
    case 'turn.completed':
      return `turn.completed (${event.stopReason})`
    case 'error':
      return `error ${event.code} : ${event.message}`
    default:
      return null
  }
}

async function main(): Promise<void> {
  const events: SillageEvent[] = []
  let status = 'idle'

  const config = {
    ...DEFAULT_CLAUDE_CONFIG,
    // Ce que `resolveDefaults` donne à une conversation réelle : la ligne `default` du
    // catalogue, que `setModel` accepte, là où la sentinelle vide le fait échouer.
    model: 'default',
    // `bypassPermissions` : la sonde ne peut répondre à aucune demande, et une réponse
    // d'un mot dans un dossier temporaire n'en appelle aucune.
    permissionMode: 'bypassPermissions' as const,
    outputStyle: 'Concise',
  }

  const ctx: RunnerContext = {
    conversationId: 'probe-settings',
    cwd: tmpdir(),
    config,
    binary: process.env.CLAUDE_BIN ?? 'claude',
    attachmentsRoot: tmpdir(),
    resumeSessionId: null,
    projectOverview: () => null,
    resolveMcpServers: () => ({ servers: [], failures: [] }),
    emit: (event) => {
      events.push(event)
      const line = describe(event)
      if (line) console.log(`  ${line}`)
    },
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

  /**
   * Un tour, attendu jusqu'à son terme puis un peu au-delà : la suggestion arrive après
   * le `result`, produite par un appel de plus, et quelques secondes lui suffisent.
   */
  const turn = async (label: string, text: string): Promise<boolean> => {
    console.log(label)
    await runner.send(text, [], [], [])
    if (!(await waitForIdle(() => status === 'idle', 120_000))) {
      console.log(`ECHEC ${label} : le tour ne s’est pas terminé`)
      return false
    }
    await settle(8000)
    return true
  }

  // Deux tours en vitesse normale : le CLI tait la suggestion sur le premier tour d'une
  // session, c'est le second qui doit la produire. Le mode rapide vient en dernier,
  // parce qu'un refus de l'API (crédits d'usage) compte comme une erreur et tait aussi
  // la suggestion de son tour.
  if (!(await turn('tour 1 : vitesse normale, style Concise', 'Reply with exactly OK and nothing else.'))) {
    await runner.stop()
    return
  }
  const suggestedAfterFirst = events.filter((event) => event.type === 'suggestion.updated').length
  if (!(await turn('tour 2 : vitesse normale', 'Reply with exactly OK again and nothing else.'))) {
    await runner.stop()
    return
  }

  console.log('bascule à chaud : fastMode = true')
  const applied = await runner.applyConfig({ ...config, fastMode: true })
  console.log(`  applyConfig : ${applied}`)

  if (!(await turn('tour 3 : mode rapide', 'Reply with exactly DONE and nothing else.'))) {
    await runner.stop()
    return
  }
  await runner.stop()

  const count = (type: SillageEvent['type']) => events.filter((event) => event.type === type).length
  const fastNotices = events.filter(
    (event) => event.type === 'agent.notice' && event.code === 'fast_mode',
  )
  console.log('')
  console.log(`session.started : ${count('session.started')} (attendu 1 pour 3 tours)`)
  console.log(`turn.completed : ${count('turn.completed')} (attendu 3)`)
  console.log(`suggestion.updated : ${count('suggestion.updated')} (attendu au moins 1, aucune après le premier tour : ${suggestedAfterFirst})`)
  console.log(`avis de mode rapide : ${fastNotices.length} (attendu 1, après le troisième tour)`)
  const verdict =
    count('session.started') === 1 &&
    count('turn.completed') === 3 &&
    count('suggestion.updated') >= 1 &&
    fastNotices.length >= 1
      ? 'OK'
      : 'ECHEC'
  console.log(verdict)
}

await main()
process.exit(0)
