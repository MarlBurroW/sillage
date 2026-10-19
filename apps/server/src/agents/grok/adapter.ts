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

/**
 * L'installeur officiel (`curl -fsSL https://x.ai/cli/install.sh | bash`) pose le
 * binaire ici et n'ajoute ce dossier qu'au PATH du shell interactif : un daemon ne l'y
 * voit pas.
 */
const INSTALLER_BINARY = join(homedir(), '.grok/bin/grok')

/** Le nom configuré, ou le chemin de l'installeur quand ce nom ne mène nulle part. */
function configuredBinary(binary: string, managedDir: string): string {
  if (resolveBinary(binary, managedDir) !== null || binary !== 'grok') return binary
  try {
    accessSync(INSTALLER_BINARY, constants.X_OK)
    return INSTALLER_BINARY
  } catch {
    return binary
  }
}

/** Rang du dernier prompt à garder dans la branche, null pour tout garder. */
interface GrokForkCut {
  targetPromptIndex: number | null
}

export class GrokAdapter implements AgentAdapter {
  readonly kind = 'grok' as const
  readonly label = 'Grok Build'
  readonly binary: string
  readonly capabilities = AGENT_CAPABILITIES.grok
  /**
   * L'ACP en version 1, avec les extensions `_x.ai/…` de Grok Build, sondé sur 1.0.62.
   * Le `raw` des événements est le `session/update` reçu, ou la réponse au
   * `session/prompt` pour une clôture de tour.
   */
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

  createRunner(ctx: RunnerContext): AgentRunner {
    return new GrokRunner(ctx)
  }

  /**
   * Le point de coupe est un rang de tour : Grok numérote les prompts de la session à
   * partir de zéro, et chaque tour de Sillage en est un (la compaction et les messages
   * glissés en cours de tour n'en ouvrent pas). Null pour tout garder.
   */
  forkCut(log: EventLog, conversationId: string, throughSeq: number): GrokForkCut {
    const turns = log.countByType(conversationId, 'turn.completed', throughSeq)
    if (turns.kept === turns.total) return { targetPromptIndex: null }
    if (turns.kept === 0) {
      throw new ForkError('No completed turn before this point: there is nothing to resume in the branch.')
    }
    return { targetPromptIndex: turns.kept - 1 }
  }

  /**
   * `_x.ai/session/fork` copie la session sur disque, tronquée après le prompt désigné,
   * sur un process jetable : la branche se reprend ensuite comme n'importe quelle
   * session. Comme chez Codex, le fork ne revient pas sur les fichiers déjà écrits.
   */
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

  async models(): Promise<AgentModelsDto> {
    const listing = await this.catalog.list()
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

  async commands(_cwd: string, force: boolean): Promise<ProjectCommandsDto> {
    const listing = await this.catalog.list(force)
    return { commands: listing.commands, fetchedAt: listing.fetchedAt }
  }

  /**
   * Consommation de l'abonnement par `_x.ai/billing` : une enveloppe de crédits par
   * semaine ou par mois. Sans connexion (ou sur une clé API), Grok refuse la lecture :
   * `limitsAvailable: false` le dit sans que ce soit une panne.
   */
  usage(force: boolean): Promise<AgentUsage> {
    return this.usageReader.read(force)
  }

  /** `credential` est ici le `GROK_HOME` du compte, voir `GrokAccountHomes`. */
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
