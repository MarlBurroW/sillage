import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  AGENT_CAPABILITIES,
  CLI_DEFAULT,
  type AgentConfig,
  type AgentModelsDto,
  type AgentUsage,
  type EditDiffDto,
  type ProjectCommandsDto,
} from '@sillage/protocol'
import type { Config } from '../../config.js'
import { CliBinary, resolveBinary } from '../cli-binary.js'
import type { EventLog } from '../../events/event-log.js'
import { AcpClient } from '../acp/client.js'
import { CLIENT_INFO } from '../codex/client-info.js'
import { agentProcessEnv } from '../process-env.js'
import { ForkError, type AgentAdapter, type DescribeEditArgs, type ForkTarget } from '../registry.js'
import type { AgentRunner, RunnerContext } from '../types.js'
import { GrokUsageReader } from './billing.js'
import { GrokCatalog } from './catalog.js'
import { GROK_ISOLATION_ENV } from './launch.js'
import { GrokRunner } from './runner.js'
import { describeEdit } from './tools.js'

/** Official installer (`curl -fsSL https://x.ai/cli/install.sh | bash`) places binaries here and updates only interactive-shell PATH, invisible to daemons. */
const INSTALLER_BINARY = join(homedir(), '.grok/bin', process.platform === 'win32' ? 'grok.exe' : 'grok')

/** Configured name, falling back to installer paths when unresolved. */
function configuredBinary(binary: string, managedDir: string): string {
  if (resolveBinary(binary, managedDir) !== null || binary !== 'grok') return binary
  try {
    accessSync(INSTALLER_BINARY, constants.X_OK)
    return INSTALLER_BINARY
  } catch {
    return binary
  }
}

/** Last prompt ordinal retained in forks; null retains everything. */
interface GrokForkCut {
  targetPromptIndex: number | null
}

export class GrokAdapter implements AgentAdapter {
  readonly kind = 'grok' as const
  readonly label = 'Grok Build'
  readonly binary: string
  readonly capabilities = AGENT_CAPABILITIES.grok
  /** ACP v1 with Grok Build `_x.ai/…` extensions, probed on 1.0.62. Event `raw` is incoming `session/update`, or `session/prompt` responses for turn completion. */
  readonly rawFormat = 'grok-acp@v1'
  readonly cli: CliBinary

  private readonly catalog: GrokCatalog
  private readonly usageReader: GrokUsageReader

  constructor(config: Config) {
    this.binary = configuredBinary(config.agents.grok.binary, config.paths.agents)
    this.cli = new CliBinary('grok', this.binary, config.agents.grok.enabled, config.paths.agents)
    this.catalog = new GrokCatalog(() => this.cli.executable())
    this.usageReader = new GrokUsageReader(() => this.cli.executable())
  }

  invalidateCatalogs(): void { this.catalog.invalidate() }

  createRunner(ctx: RunnerContext): AgentRunner {
    return new GrokRunner(ctx)
  }

  /** Cut points are prompt ordinals: Grok numbers from zero, and each Sillage turn corresponds to one prompt. Compaction and mid-turn steering do not create prompts. Null retains all. */
  forkCut(log: EventLog, conversationId: string, throughSeq: number): GrokForkCut {
    const turns = log.countByType(conversationId, 'turn.completed', throughSeq)
    if (turns.kept === turns.total) return { targetPromptIndex: null }
    if (turns.kept === 0) {
      throw new ForkError('No completed turn before this point: there is nothing to resume in the branch.')
    }
    return { targetPromptIndex: turns.kept - 1 }
  }

  /** `_x.ai/session/fork` copies disk sessions truncated after specified prompts through disposable processes. Resume forks normally afterward. Like Codex, forks do not restore written files. */
  async fork(target: ForkTarget, cut: unknown): Promise<string> {
    const { targetPromptIndex } = cut as GrokForkCut
    const client = new AcpClient({
      label: 'grok',
      binary: await this.cli.executable(),
      args: ['agent', '--no-leader', 'stdio'],
      cwd: target.cwd,
      env: agentProcessEnv(GROK_ISOLATION_ENV),
    })
    try {
      await client.initialize(CLIENT_INFO)
      const forked = await client.request<{ newSessionId?: unknown }>('_x.ai/session/fork', {
        sourceSessionId: target.agentSessionId,
        sourceCwd: target.cwd,
        newCwd: target.cwd,
        ...(targetPromptIndex === null ? {} : { targetPromptIndex }),
      })
      if (typeof forked.newSessionId !== 'string') throw new Error('no session id in the response')
      return forked.newSessionId
    } catch (err) {
      throw new ForkError(`Grok Build could not fork the session: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      client.close()
    }
  }

  /** `home` is the account's `GROK_HOME`; see GrokAccountHomes. */
  async models(home?: string, force = false): Promise<AgentModelsDto> {
    const listing = await this.catalog.list(home, force)
    return {
      models: listing.models.map((model) => ({
        value: model.id,
        displayName: model.name,
        description: model.description,
        hint: model.id,
        isDefault: model.id === listing.current,
        efforts: model.efforts.map((effort) => ({ value: effort.id, label: effort.label, hint: effort.description })),
        defaultEffort: model.defaultEffort,
        supportsFastMode: false,
      })),
      modes: [],
      account: null,
      outputStyles: [],
      fastMode: null,
      agents: [],
      fetchedAt: listing.fetchedAt,
    }
  }

  async commands(_cwd: string, force: boolean, home?: string): Promise<ProjectCommandsDto> {
    const listing = await this.catalog.list(home, force)
    return { commands: listing.commands, fetchedAt: listing.fetchedAt }
  }

  /** Subscription usage through `_x.ai/billing`: weekly/monthly credit allowances. Unauthenticated/API-key reads are rejected normally; report `limitsAvailable: false` rather than failure. */
  usage(force: boolean): Promise<AgentUsage> {
    return this.usageReader.read(force)
  }

  /** credential is this account's GROK_HOME; see GrokAccountHomes. */
  usageForAccount(accountId: string, credential: string, force: boolean): Promise<AgentUsage> {
    return this.usageReader.readForAccount(accountId, credential, force)
  }

  async resolveDefaults(config: AgentConfig): Promise<AgentConfig> {
    if (config.agent !== 'grok') return config
    if (config.model !== CLI_DEFAULT && config.reasoningEffort !== CLI_DEFAULT) return config
    const listing = await this.catalog.list().catch(() => null)
    if (!listing) return config
    const model = config.model || listing.current || ''
    const effort = config.reasoningEffort || listing.models.find((entry) => entry.id === model)?.defaultEffort || ''
    return { ...config, model, reasoningEffort: effort }
  }

  describeEdit({ log, conversationId, toolCallId, cwd, path }: DescribeEditArgs): EditDiffDto {
    return describeEdit(log.rawOfTool(conversationId, toolCallId).completed, cwd, path)
  }
}
