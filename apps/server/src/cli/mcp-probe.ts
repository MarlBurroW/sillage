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

/** End-to-end MCP integration probe using real runners. Documentation cannot prove that declared servers actually reach CLIs and survive resumes, where Codex loses them unless configuration is resent. Not a substitute for tests: launches authenticated real CLIs and spends real model turns. Run manually when changing this path. */

const PROBE_NAME = 'sillage_probe'

const probeServer: McpServer = {
  id: randomUUID(),
  name: PROBE_NAME,
  enabled: true,
  transport: {
    type: 'stdio',
    // Minimal listable MCP server without networking, so failures identify
    // the integration path under probe.
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
    projectOverview: () => null, maskedInstructionRoots: () => [], memoryDir: () => null,
    resolveMcpServers: () => ({ servers: [probeServer], failures: [] }),
    skillRoots: () => [],
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

/** Inventory arrives asynchronously because CLIs start servers afterward. */
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

  // Threads without turns have no disk rollout and `thread/resume` rejects them.
  await codex.runner.send('Reply with exactly: ok', [], [], [])
  await settle(15_000)
  const threadId = codex.sessionId()
  await codex.runner.stop()

  if (!threadId) {
    console.log('ECHEC codex, reprise -> aucun identifiant de thread')
    return
  }

  // Case silently breaking when resume omits configuration.
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
