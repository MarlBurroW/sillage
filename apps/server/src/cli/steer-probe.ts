import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { DEFAULT_CLAUDE_CONFIG, type SillageEvent } from '@sillage/protocol'
import { ClaudeRunner } from '../agents/claude/runner.js'
import type { RunnerContext } from '../agents/types.js'

/** Manual Claude same-turn message-folding probe. Undocumented behavior: SDKUserMessage `priority` has no comment and Streaming Input still documents strict queues. Measure rather than infer for future SDK bumps. Three slow commands create tool-batch boundaries where injected messages may fold; steer during the first, leaving two opportunities. One `turn.completed` means it joined the current turn; two means ordinary queuing. Uses authenticated real CLIs and costs real model turns; run manually when changing this path. */

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

/** Waits for completion rather than fixed durations because CLI timing varies. */
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
    // `bypassPermissions`: probes cannot answer approval requests, and three sleeps
    // in temporary directories require no judgment.
    config: { ...DEFAULT_CLAUDE_CONFIG, permissionMode: 'bypassPermissions' },
    binary: process.env.CLAUDE_BIN ?? 'claude',
    attachmentsRoot: tmpdir(),
    resumeSessionId: null,
    projectOverview: () => null, maskedInstructionRoots: () => [], memoryDir: () => null,
    resolveMcpServers: () => ({ servers: [], failures: [] }),
    skillRoots: () => [],
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

  // Late enough for turn and first tool startup, early enough to leave two
  // commands and therefore two folding boundaries.
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
