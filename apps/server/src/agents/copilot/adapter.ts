import { AGENT_CAPABILITIES, CLI_DEFAULT, type AgentConfig, type AgentModelsDto, type AgentUsage, type ProjectCommandsDto } from '@sillage/protocol'
import { join } from 'node:path'
import type { Config } from '../../config.js'
import { describeEdit } from '../acp/content.js'
import { CliBinary } from '../cli-binary.js'
import { ForkError, type AgentAdapter, type DescribeEditArgs } from '../registry.js'
import type { AgentRunner, RunnerContext } from '../types.js'
import { CopilotCatalog } from './catalog.js'
import { CopilotRunner } from './runner.js'
import { copilotUsage, type ObservedQuota } from './usage.js'

export class CopilotAdapter implements AgentAdapter {
  readonly kind = 'copilot' as const
  readonly label = 'GitHub Copilot CLI'
  readonly capabilities = AGENT_CAPABILITIES.copilot
  /**
   * ACP v1 from `copilot --acp`, probed on 1.0.116. Event `raw` is the incoming `session/update`,
   * the `github.com/copilot/sessionEvent` notification an event was read from, or the
   * `session/prompt` response for a turn's end; a closed tool keeps `{update, diffs}`.
   */
  readonly rawFormat = 'copilot-acp@v1'
  readonly binary: string
  readonly cli: CliBinary
  private readonly catalog: CopilotCatalog
  private readonly stateDir: string
  /** Quota as the last model call reported it, per `COPILOT_HOME` (empty for the machine's sign-in); see `usage.ts`. */
  private readonly observed = new Map<string, ObservedQuota>()

  constructor(config: Config) {
    this.binary = config.agents.copilot.binary
    this.cli = new CliBinary(this.kind, this.label, this.binary, config.agents.copilot.enabled, config.paths.agents)
    this.stateDir = config.paths.copilot
    this.catalog = new CopilotCatalog(() => this.cli.executable(), join(this.stateDir, 'catalog'))
  }

  invalidateCatalogs(): void { this.catalog.invalidate() }

  createRunner(ctx: RunnerContext): AgentRunner {
    return new CopilotRunner(ctx, { stateDir: this.stateDir, onQuota: (quota, credits, home) => { this.observed.set(home, { quota, credits, at: Date.now() }) } })
  }

  forkCut(): never { throw new ForkError('GitHub Copilot uses a portable history fork.') }
  async fork(): Promise<string> { throw new ForkError('GitHub Copilot has no native fork RPC. Use the portable history fork.') }

  /** `home` is an extra account's `COPILOT_HOME`; see CopilotAccountHomes. */
  async models(home?: string, force = false): Promise<AgentModelsDto> {
    return (await this.catalog.list(force, home)).models
  }

  async commands(_cwd: string, force: boolean, home?: string): Promise<ProjectCommandsDto> {
    const listing = await this.catalog.list(force, home)
    return { commands: listing.commands, fetchedAt: listing.fetchedAt }
  }

  /**
   * Copilot's ACP exposes no quota call in 1.0.116, and `/usage` reports the session only: the
   * gauge is what the last turn reported, and nothing (rather than a failure) before any turn.
   */
  async usage(): Promise<AgentUsage> {
    return copilotUsage(this.observed.get('') ?? null)
  }

  /** `home` is the account's `COPILOT_HOME`: its gauge is what its own last turn reported. */
  async usageForAccount(_accountId: string, home: string): Promise<AgentUsage> {
    return copilotUsage(this.observed.get(home) ?? null)
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
