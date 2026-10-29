import { AGENT_CAPABILITIES, type AgentConfig, type AgentModelsDto, type AgentUsage, type ProjectCommandsDto } from '@sillage/protocol'
import type { Config } from '../../config.js'
import { AcpClient } from '../acp/client.js'
import { describeEdit } from '../acp/content.js'
import { CliBinary } from '../cli-binary.js'
import { CLIENT_INFO } from '../codex/client-info.js'
import { ForkError, type AgentAdapter, type DescribeEditArgs } from '../registry.js'
import type { AgentRunner, RunnerContext } from '../types.js'
import { antigravityEnv, userAntigravityHome } from '../../antigravity-accounts/homes.js'
import { AntigravityCatalog } from './catalog.js'
import { antigravityArgs } from './launch.js'
import { AntigravityRunner } from './runner.js'

export class AntigravityAdapter implements AgentAdapter {
  readonly kind = 'antigravity' as const
  readonly label = 'Google Antigravity'
  readonly capabilities = AGENT_CAPABILITIES.antigravity
  readonly rawFormat = 'antigravity-acp@v1'
  readonly binary: string
  readonly cli: CliBinary
  private readonly catalog: AntigravityCatalog
  constructor(config: Config) {
    this.binary = config.agents.antigravity.binary
    this.cli = new CliBinary(this.kind, this.label, this.binary, config.agents.antigravity.enabled, config.paths.agents, async (binary) => {
      const client = new AcpClient({ label: 'antigravity-version', binary, args: antigravityArgs(), env: antigravityEnv(userAntigravityHome(), false), onStderr: () => {} })
      try { return (await client.initialize(CLIENT_INFO)).agentInfo?.version ?? null } catch { return null } finally { client.close() }
    })
    this.catalog = new AntigravityCatalog(() => this.cli.executable())
  }
  invalidateCatalogs(): void { this.catalog.invalidate() }

  createRunner(ctx: RunnerContext): AgentRunner { return new AntigravityRunner(ctx) }
  forkCut(): never { throw new ForkError('Antigravity uses a portable history fork.') }
  async fork(): Promise<string> { throw new ForkError('Antigravity has no native fork RPC. Use the portable history fork.') }
  async models(home?: string, force = false): Promise<AgentModelsDto> { return (await this.catalog.list(home, undefined, force)).models }
  async commands(cwd: string, force: boolean, home?: string): Promise<ProjectCommandsDto> {
    const listing = await this.catalog.list(home, cwd, force)
    return { commands: listing.commands, fetchedAt: listing.fetchedAt }
  }
  usage(force: boolean): Promise<AgentUsage> { return this.catalog.usage(undefined, force) }
  usageForAccount(_id: string, home: string, force: boolean): Promise<AgentUsage> { return this.catalog.usage(home, force) }
  async resolveDefaults(config: AgentConfig): Promise<AgentConfig> { return config }
  describeEdit({ log, conversationId, toolCallId, cwd, path }: DescribeEditArgs) {
    return describeEdit(log.rawOfTool(conversationId, toolCallId).completed, cwd, path)
  }
}
