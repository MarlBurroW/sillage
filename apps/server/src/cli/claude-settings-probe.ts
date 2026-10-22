import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { DEFAULT_CLAUDE_CONFIG, type SillageEvent } from '@sillage/protocol'
import { ClaudeRunner } from '../agents/claude/runner.js'
import type { RunnerContext } from '../agents/types.js'

/** Probes CLI flag-layer session settings: output style, fast mode and next-message suggestions. Documentation exposes little beyond SDK types: `applyFlagSettings` is streaming-input-only, SDK fast opt-in (`sdk_opt_in_required`) appears only in reason unions, and suggestions follow `result`. Measure behavior for future SDK bumps. Tiny turns should produce one session start, suggestions and no fast notice in standard Concise mode, then fast-mode activation or account rejection after live changes. Manual authenticated real-CLI probe, not tests, costing actual turns including usage-credit fast pricing. */

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
    // Real `resolveDefaults` uses catalog `default`, accepted by `setModel`,
    // unlike empty sentinels that fail.
    model: 'default',
    // `bypassPermissions`: probes cannot answer requests, and single-word replies
    // in temporary directories require no judgment.
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
    projectOverview: () => null, maskedInstructionRoots: () => [], memoryDir: () => null,
    resolveMcpServers: () => ({ servers: [], failures: [] }),
    skillRoots: () => [],
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

  /** Wait through turn completion and slightly beyond: suggestions use an additional call after `result`, normally a few seconds. */
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

  // Two standard-speed turns: CLI suppresses suggestions on first turns and should
  // produce them on second turns. Fast mode comes last because API credit
  // rejections count as errors and also suppress
  // the suggestion for that turn.
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
