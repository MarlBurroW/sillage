import { AGENT_CAPABILITIES, CLI_DEFAULT, type AgentConfig, type AgentModelsDto, type AgentUsage, type ProjectCommandsDto } from '@sillage/protocol'
import type { Config } from '../../config.js'
import { describeEdit } from '../acp/content.js'
import { CliBinary } from '../cli-binary.js'
import { ForkError, type AgentAdapter, type DescribeEditArgs } from '../registry.js'
import type { AgentRunner, RunnerContext } from '../types.js'
import { CopilotCatalog } from './catalog.js'
import { CopilotRunner } from './runner.js'

export class CopilotAdapter implements AgentAdapter {
  readonly kind = 'copilot' as const
  readonly label = 'GitHub Copilot CLI'
  readonly capabilities = AGENT_CAPABILITIES.copilot
  /** Plain ACP v1 from `copilot --acp`, probed on 1.0.116. Event `raw` is incoming `session/update`, or `session/prompt` responses for turn completion. */
  readonly rawFormat = 'copilot-acp@v1'
  readonly binary: string
  readonly cli: CliBinary
  private readonly catalog: CopilotCatalog

  constructor(config: Config) {
    this.binary = config.agents.copilot.binary
    this.cli = new CliBinary(this.kind, this.label, this.binary, config.agents.copilot.enabled, config.paths.agents)
    this.catalog = new CopilotCatalog(() => this.cli.executable())
  }

  invalidateCatalogs(): void { this.catalog.invalidate() }

  createRunner(ctx: RunnerContext): AgentRunner { return new CopilotRunner(ctx) }

  forkCut(): never { throw new ForkError('GitHub Copilot uses a portable history fork.') }
  async fork(): Promise<string> { throw new ForkError('GitHub Copilot has no native fork RPC. Use the portable history fork.') }

  async models(_credential?: string, force = false): Promise<AgentModelsDto> {
    return (await this.catalog.list(force)).models
  }

  async commands(_cwd: string, force: boolean): Promise<ProjectCommandsDto> {
    const listing = await this.catalog.list(force)
    return { commands: listing.commands, fetchedAt: listing.fetchedAt }
  }

  /**
   * Copilot's ACP exposes no quota call in 1.0.116; `/usage` reports the session only. Say
   * there is nothing to show rather than fail.
   */
  async usage(): Promise<AgentUsage> {
    return { agent: 'copilot', plan: null, limitsAvailable: false, windows: [], credits: null, fetchedAt: Date.now() }
  }

  /** The catalog decides; if unreachable, keep the sentinel so Copilot applies its own default. */
  async resolveDefaults(config: AgentConfig): Promise<AgentConfig> {
    if (config.agent !== 'copilot') return config
    if (config.model !== CLI_DEFAULT && config.reasoningEffort !== CLI_DEFAULT) return config
    const listing = await this.catalog.list().catch(() => null)
    if (!listing) return config
    const model = config.model || listing.models.models.find((entry) => entry.isDefault)?.value || ''
    const effort = config.reasoningEffort || listing.models.models.find((entry) => entry.value === model)?.defaultEffort || ''
    return { ...config, model, reasoningEffort: effort }
  }

  describeEdit({ log, conversationId, toolCallId, cwd, path }: DescribeEditArgs) {
    return describeEdit(log.rawOfTool(conversationId, toolCallId).completed, cwd, path)
  }
}
