import type {
  AgentCapabilities,
  AgentConfig,
  AgentKind,
  AgentModelsDto,
  AgentUsage,
  EditDiffDto,
} from '@sillage/protocol'
import type { Config } from '../config.js'
import type { EventLog } from '../events/event-log.js'
import { ClaudeAdapter } from './claude/adapter.js'
import { CodexAdapter } from './codex/adapter.js'
import type { AgentRunner, RunnerContext } from './types.js'

export class ForkError extends Error {}

/** Session native à brancher. L'exécutable, lui, appartient à l'adaptateur. */
export interface ForkTarget {
  agentSessionId: string
  cwd: string
}

/** Ce qu'il faut à un adaptateur pour reconstituer l'effet d'un appel d'outil. */
export interface DescribeEditArgs {
  log: EventLog
  conversationId: string
  toolCallId: string
  cwd: string
  path: string
}

/**
 * Tout ce qu'un CLI apporte à Sillage, réuni derrière une seule porte (invariant I3).
 *
 * Le reste du serveur ne branche jamais sur le type d'agent : il demande l'adaptateur
 * au registre et lui parle. Ajouter un CLI, c'est écrire une implémentation de cette
 * interface et l'inscrire dans `createAgentRegistry`, sans toucher aux routes, au
 * gestionnaire de sessions ni au journal.
 */
export interface AgentAdapter {
  readonly kind: AgentKind
  /** Nom du CLI tel qu'on le montre dans les messages d'erreur. */
  readonly label: string
  /**
   * Exécutable du CLI, tel que la configuration le déclare. Ne jamais réécrire en dur
   * le nom du binaire : sous systemd le PATH est minimal, et pointer sur un chemin
   * absolu est la seule façon fiable de lancer un CLI installé dans ~/.local/bin.
   */
  readonly binary: string
  /**
   * Capacités annoncées, tirées de la table partagée du protocole : l'UI s'en sert
   * pour ne pas proposer un geste refusé, le runner garde le refus comme filet.
   */
  readonly capabilities: AgentCapabilities
  /**
   * Provenance estampillée sur les payloads natifs journalisés
   * (« codex-app-server@v2 »...). À bumper quand le protocole du CLI change de
   * forme : c'est ce qui permettra de relire un vieux `raw` avec le bon lecteur.
   */
  readonly rawFormat: string
  createRunner(ctx: RunnerContext): AgentRunner
  /**
   * Point de coupe natif d'un fork, lu depuis le journal. Opaque hors de
   * l'adaptateur : Claude coupe à une entrée de transcript, Codex retire des tours
   * entiers, et un prochain CLI aura sa propre représentation.
   */
  forkCut(log: EventLog, conversationId: string, throughSeq: number): unknown
  /**
   * Branche la session native au point de coupe et retourne l'identifiant de la
   * branche, prête à être reprise. Aucun runner requis : le fork travaille sur ce que
   * le CLI a persisté.
   */
  fork(target: ForkTarget, cut: unknown): Promise<string>
  /** Payload de la route `/api/agents/:agent/models`, lu sur le CLI installé. */
  models(): Promise<AgentModelsDto>
  usage(force: boolean): Promise<AgentUsage>
  /**
   * Remplace les `CLI_DEFAULT` d'une configuration par ce que le CLI annonce
   * réellement. Si le catalogue est injoignable, la sentinelle reste : le CLI
   * appliquera son propre défaut au lancement, ce qui reste juste.
   */
  resolveDefaults(config: AgentConfig): Promise<AgentConfig>
  /** Effet d'un appel d'outil sur un fichier, reconstitué depuis le payload natif. */
  describeEdit(args: DescribeEditArgs): EditDiffDto
}

export class AgentRegistry {
  private readonly adapters: ReadonlyMap<AgentKind, AgentAdapter>

  constructor(adapters: AgentAdapter[]) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.kind, adapter]))
  }

  adapter(kind: AgentKind): AgentAdapter {
    const adapter = this.adapters.get(kind)
    // Impossible tant que le registre couvre l'enum AgentKind : ce garde ne sert
    // qu'à transformer un oubli d'inscription en panne franche plutôt que silencieuse.
    if (!adapter) throw new Error(`Aucun adaptateur inscrit pour le CLI « ${kind} ».`)
    return adapter
  }

  /** Variante tolérante pour les paramètres d'URL, où le nom vient du client. */
  find(kind: string): AgentAdapter | null {
    return this.adapters.get(kind as AgentKind) ?? null
  }
}

export function createAgentRegistry(config: Config): AgentRegistry {
  return new AgentRegistry([new ClaudeAdapter(config), new CodexAdapter(config)])
}
