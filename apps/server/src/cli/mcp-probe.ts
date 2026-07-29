import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_CLAUDE_CONFIG,
  DEFAULT_CODEX_CONFIG,
  type AgentConfig,
  type McpServer,
  type SillageEvent,
} from '@sillage/protocol'
import { ClaudeRunner } from '../agents/claude/runner.js'
import { CodexRunner } from '../agents/codex/runner.js'
import type { AgentRunner, RunnerContext } from '../agents/types.js'

/**
 * Sonde de bout en bout du chemin MCP, sur le vrai code des runners.
 *
 * Ce que la sonde vérifie ne se déduit d'aucune documentation : que les serveurs
 * déclarés dans Sillage arrivent bien jusqu'au CLI, et surtout qu'ils survivent à une
 * reprise de session, cas où Codex les perd si la configuration n'est pas repassée.
 *
 * Ne remplace pas un test : elle lance de vrais CLI, coûte un vrai tour de modèle et
 * demande des CLI authentifiés. Elle se lance à la main, quand on touche à ce chemin.
 */

const PROBE_NAME = 'sillage_probe'

const probeServer: McpServer = {
  id: randomUUID(),
  name: PROBE_NAME,
  enabled: true,
  transport: {
    type: 'stdio',
    // Un serveur MCP réduit à ce qu'il faut pour être listé : pas de réseau, donc un
    // échec ne peut venir que du chemin qu'on sonde.
    command: process.execPath,
    args: [join(import.meta.dirname, 'mcp-probe-server.mjs')],
    env: {},
  },
  createdAt: Date.now(),
  updatedAt: Date.now(),
}

interface Probe {
  runner: AgentRunner
  seen: () => string[]
  sessionId: () => string | null
}

function buildProbe(config: AgentConfig, binary: string, resumeSessionId: string | null): Probe {
  const seen: string[] = []
  let sessionId: string | null = null

  const ctx: RunnerContext = {
    conversationId: `probe-${config.agent}`,
    cwd: tmpdir(),
    config,
    binary,
    attachmentsRoot: tmpdir(),
    resumeSessionId,
    resolveMcpServers: () => ({ servers: [probeServer], failures: [] }),
    emit: (event: SillageEvent) => {
      if (event.type === 'mcp.updated') {
        for (const server of event.servers) {
          const origin = server.external ? 'externe' : 'sillage'
          seen.push(`${server.name}:${server.state}:${origin}:${server.tools.length}outils`)
        }
      }
    },
    setStatus: () => {},
    setAgentSessionId: (id) => {
      sessionId = id
    },
    updateConfig: () => {},
    openPermissionRequest: () => randomUUID(),
    closePermissionRequest: () => {},
  }

  const runner =
    config.agent === 'claude' ? new ClaudeRunner(ctx) : new CodexRunner(ctx)
  return { runner, seen: () => seen, sessionId: () => sessionId }
}

/** L'inventaire arrive de façon asynchrone : le CLI démarre ses serveurs après coup. */
const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const report = (label: string, seen: string[]) => {
  const ours = seen.filter((entry) => entry.startsWith(`${PROBE_NAME}:`))
  console.log(`${ours.length > 0 ? 'OK  ' : 'ECHEC'} ${label} -> ${JSON.stringify(seen)}`)
}

async function main(): Promise<void> {
  const claudeBinary = process.env.CLAUDE_BIN ?? 'claude'
  const codexBinary = process.env.CODEX_BIN ?? 'codex'

  const claude = buildProbe({ ...DEFAULT_CLAUDE_CONFIG, mcpServers: [probeServer.id] }, claudeBinary, null)
  await claude.runner.start()
  await settle(4000)
  report('claude, au lancement', claude.seen())
  await claude.runner.stop()

  const codex = buildProbe({ ...DEFAULT_CODEX_CONFIG, mcpServers: [probeServer.id] }, codexBinary, null)
  await codex.runner.start()
  await settle(4000)
  report('codex, au lancement', codex.seen())

  // Un thread sans tour n'a pas de rollout sur disque, et `thread/resume` le refuse.
  await codex.runner.send('Reply with exactly: ok', [], [])
  await settle(15_000)
  const threadId = codex.sessionId()
  await codex.runner.stop()

  if (!threadId) {
    console.log('ECHEC codex, reprise -> aucun identifiant de thread')
    return
  }

  // Le cas qui casse en silence si la configuration n'est pas repassée au resume.
  const resumed = buildProbe(
    { ...DEFAULT_CODEX_CONFIG, mcpServers: [probeServer.id] },
    codexBinary,
    threadId,
  )
  await resumed.runner.start()
  await settle(4000)
  report('codex, après reprise', resumed.seen())
  await resumed.runner.stop()
}

await main()
process.exit(0)
