import type { Db } from '@sillage/db'
import type { AgentKind } from '@sillage/protocol'
import { AgentRegistry, type AgentAdapter } from '../src/agents/registry.js'
import type { AgentRunner, RunnerContext } from '../src/agents/types.js'
import type { Config } from '../src/config.js'
import type { EventLog } from '../src/events/event-log.js'
import { SessionManager } from '../src/sessions/session-manager.js'

/**
 * A runner that does nothing, with the methods a test cares about overridden. Typed against
 * `AgentRunner`, so a method added to the interface or a changed signature fails the test
 * typecheck instead of a cast hiding it.
 */
export function fakeRunner(ctx: RunnerContext, overrides: Partial<AgentRunner> = {}): AgentRunner {
  return {
    conversationId: ctx.conversationId,
    appliedConfig: ctx.config,
    async start() {},
    async send() { ctx.setStatus('running') },
    async applyConfig() { return false },
    async reloadSkillLibrary() {},
    async reconnectMcpServer() { return false },
    async suggestedTitle() { return null },
    async interrupt() {},
    resolvePermission: () => false,
    answerQuestion: () => false,
    resolveElicitation: () => false,
    async steer() { return false },
    async compact() { return false },
    reviewPlan: () => false,
    async stopBackgroundTask() { return false },
    async stop() {},
    ...overrides,
  }
}

/** An adapter launching no CLI: only what `SessionManager` reads to start and stop runners. */
export function fakeAdapter(kind: AgentKind, managedDir: string, createRunner: (ctx: RunnerContext) => AgentRunner): AgentAdapter {
  return {
    kind, label: kind, binary: 'sillage-test-no-cli', rawFormat: 'test',
    cli: { managedDir, assertEnabled() {} },
    createRunner,
  } as unknown as AgentAdapter
}

/**
 * A real SessionManager. Dependencies are named: the constructor takes ten positional ones, and
 * tests passing a row of `{} as never` silently shifted when one was inserted. Absent account
 * stores and secrets are left empty, as tests without accounts never reach them.
 */
export function makeSessionManager(deps: {
  db: Db
  log: EventLog
  config: Config
} & ({ adapters: AgentAdapter[] } | { registry: AgentRegistry }) & Partial<SessionManagerDeps>): SessionManager {
  return new SessionManager(
    deps.db, deps.log, deps.config, 'registry' in deps ? deps.registry : new AgentRegistry(deps.adapters),
    deps.secrets ?? ({} as never), deps.claudeAccounts ?? ({} as never), deps.codexAccounts ?? ({} as never),
    deps.grokAccounts ?? ({} as never), deps.antigravityAccounts ?? ({} as never), deps.usage ?? null,
  )
}

type Params = ConstructorParameters<typeof SessionManager>
interface SessionManagerDeps {
  secrets: Params[4]
  claudeAccounts: Params[5]
  codexAccounts: Params[6]
  grokAccounts: Params[7]
  antigravityAccounts: Params[8]
  usage: Params[9]
}
