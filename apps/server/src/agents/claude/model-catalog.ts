import { homedir } from 'node:os'
import {
  query,
  type AccountInfo,
  type ModelInfo,
  type SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk'
import { AsyncQueue } from '../async-queue.js'
import { CachedProbe } from '../cached-probe.js'

/**
 * Catalogue Claude : modèles et compte, lus depuis le CLI installé plutôt que codés
 * en dur.
 *
 * `supportedModels()` et `accountInfo()` sont des requêtes de contrôle : elles
 * exigent un process CLI vivant, mais aucun message n'est envoyé, donc elles ne
 * consomment ni tokens ni quota. Le process coûte en revanche ~400 Mo le temps de la
 * sonde, d'où le cache et le fait que les deux informations soient lues d'un coup.
 */

const CACHE_TTL_MS = 60 * 60 * 1000
const PROBE_TIMEOUT_MS = 20_000

interface Listing {
  models: ModelInfo[]
  account: AccountInfo | null
}

export class ClaudeModelCatalog {
  private readonly cached = new CachedProbe(CACHE_TTL_MS, () => this.probe())

  /**
   * Le binaire est résolu à chaque sonde, jamais retenu à la construction : c'est ce qui
   * fait honorer le préfixe des CLI que Sillage installe lui-même, et le réglage
   * `agents.claude.binary`, y compris pour un CLI installé pendant que le daemon tourne.
   */
  constructor(private readonly executable: () => Promise<string>) {}

  list(): Promise<Listing & { fetchedAt: number }> {
    return this.cached.read()
  }

  private async probe(): Promise<Listing> {
    // La file reste vide : le CLI démarre, répond aux requêtes de contrôle, et
    // s'arrête sans qu'aucun tour de conversation n'ait lieu.
    const input = new AsyncQueue<SDKUserMessage>()
    const abort = new AbortController()

    const session = query({
      prompt: input,
      options: {
        cwd: homedir(),
        abortController: abort,
        // Toujours renseigné, jamais laissé au SDK : sa résolution interne cherche le
        // binaire du paquet plateforme `@anthropic-ai/claude-agent-sdk-<os>-<arch>`, que
        // la release ne transporte plus. Sans ce chemin la sonde échoue en quelques
        // millisecondes sur « Native CLI binary not found », et l'agent paraît absent
        // alors que son CLI est installé.
        pathToClaudeCodeExecutable: await this.executable(),
        // La sortie d'erreur du CLI est la seule explication d'une sonde ratée : la
        // jeter ne laisse au serveur qu'un 502 sans motif.
        stderr: (data) => process.stderr.write(`[claude catalog] ${data}`),
      },
    })

    const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS)
    try {
      const models = await session.supportedModels()
      // Le compte est secondaire : son absence ne doit pas priver l'UI des modèles.
      const account = await session.accountInfo().catch(() => null)
      return { models, account }
    } finally {
      clearTimeout(timer)
      input.close()
      abort.abort()
    }
  }
}
