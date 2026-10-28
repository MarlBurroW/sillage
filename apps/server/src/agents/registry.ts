import { AntigravityAdapter } from './antigravity/adapter.js'
import type {
  AgentCapabilities,
  AgentConfig,
  AgentKind,
  AgentModelsDto,
  AgentUsage,
  EditDiffDto,
  ProjectCommandsDto,
} from '@sillage/protocol'
import type { Config } from '../config.js'
import type { EventLog } from '../events/event-log.js'
import { ClaudeAdapter } from './claude/adapter.js'
import type { CliBinary } from './cli-binary.js'
import { CodexAdapter } from './codex/adapter.js'
import { GrokAdapter } from './grok/adapter.js'
import { OpencodeAdapter } from './opencode/adapter.js'
import type { AgentRunner, RunnerContext } from './types.js'

export class ForkError extends Error {}

/** Native session to fork; executables belong to adapters. */
export interface ForkTarget {
  agentSessionId: string
  cwd: string
}

/** Adapter inputs for reconstructing tool-call effects. */
export interface DescribeEditArgs {
  log: EventLog
  conversationId: string
  toolCallId: string
  cwd: string
  path: string
}

/** Single interface for everything CLIs provide (invariant I3). Other server code never branches by agent type: request adapters from registries. Add CLIs by implementing this interface and registering in `createAgentRegistry`, without changing routes, session managers or journals. */
export interface AgentAdapter {
  readonly kind: AgentKind
  /** CLI name displayed in errors. */
  readonly label: string
  /** Configured CLI executable. Never hardcode binary names: systemd PATH is minimal, so absolute paths reliably reach ~/.local/bin installations. */
  readonly binary: string
  /** Installed CLI presence/version through PATH resolution. System binaries are not bundled, so absence is normal and must be visible in interfaces. */
  readonly cli: CliBinary
  /** Capabilities from the shared protocol table prevent interfaces offering rejected actions; runners retain rejection as a safeguard. */
  readonly capabilities: AgentCapabilities
  /** Provenance stamped on native journal payloads ('codex-app-server@v2', 'opencode-server@v1', 'grok-acp@v1'…). Bump when native protocol shapes change so old `raw` can use the correct reader. */
  readonly rawFormat: string
  createRunner(ctx: RunnerContext): AgentRunner
  /** Journal-derived native fork cut point, opaque outside adapters: transcript entries for Claude, whole-turn rollback for Codex, future CLIs' own representations. */
  forkCut(log: EventLog, conversationId: string, throughSeq: number): unknown
  /** Forks persisted native sessions at cut points and returns resumable branch IDs. No runner required because the CLI already persisted data. */
  fork(target: ForkTarget, cut: unknown): Promise<string>
  /** `/api/agents/:agent/models` payload read from installed CLIs. `credential` selects an additional account's catalog where the plan decides the list (see `usageForAccount`); `force` bypasses caches for refresh buttons. */
  models(credential?: string, force?: boolean): Promise<AgentModelsDto>
  /** Drop account catalogs after the installed executable changes. */
  invalidateCatalogs?(): void
  usage(force: boolean): Promise<AgentUsage>
  /** Same catalog read for additional accounts. `credential` identifies accounts to CLIs: Claude tokens (`ClaudeAccountStore`), Codex `CODEX_HOME` (`CodexAccountHomes`). Optional for CLIs without additional accounts. */
  usageForAccount?(accountId: string, credential: string, force: boolean): Promise<AgentUsage>
  /** Recognized slash commands in directories without running sessions, serving drafts. Unsupported CLIs return empty lists; `force` bypasses caches for refresh buttons. */
  commands(cwd: string, force: boolean, credential?: string): Promise<ProjectCommandsDto>
  /** Replaces `CLI_DEFAULT` with actual CLI announcements. Unreachable catalogs leave sentinels so CLIs apply their own startup defaults correctly. */
  resolveDefaults(config: AgentConfig): Promise<AgentConfig>
  /** File effects reconstructed from native tool payloads. */
  describeEdit(args: DescribeEditArgs): EditDiffDto
}

export class AgentRegistry {
  private readonly adapters: ReadonlyMap<AgentKind, AgentAdapter>

  constructor(adapters: AgentAdapter[]) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.kind, adapter]))
  }

  adapter(kind: AgentKind): AgentAdapter {
    const adapter = this.adapters.get(kind)
    // Impossible while the registry covers AgentKind; this guard turns missing
    // registrations into explicit failures rather than silent ones.
    if (!adapter) throw new Error(`Aucun adaptateur inscrit pour le CLI « ${kind} ».`)
    return adapter
  }

  /** Tolerant URL-parameter lookup for client-provided names. */
  find(kind: string): AgentAdapter | null {
    return this.adapters.get(kind as AgentKind) ?? null
  }

  /** All registered adapters including configuration-disabled CLIs, whose state must still display. */
  all(): AgentAdapter[] {
    return [...this.adapters.values()]
  }
}

export function createAgentRegistry(config: Config): AgentRegistry {
  return new AgentRegistry([
    new ClaudeAdapter(config),
    new CodexAdapter(config),
    new OpencodeAdapter(config),
    new GrokAdapter(config),
    new AntigravityAdapter(config),
  ])
}
