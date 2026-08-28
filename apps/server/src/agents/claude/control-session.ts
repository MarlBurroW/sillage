import { query, type Options, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { AsyncQueue } from '../async-queue.js'

/**
 * Une session Claude ouverte le temps d'une requête de contrôle, puis refermée.
 *
 * `supportedModels()`, `supportedCommands()`, `usage…()` exigent un process CLI
 * vivant, mais aucun message n'est envoyé : la file d'entrée reste vide, le CLI
 * démarre, répond, s'arrête, sans consommer ni tokens ni quota. Le squelette
 * (file, abandon, délai, fermeture) était recopié dans chaque catalogue ; il est ici
 * pour que la prochaine correction du cycle de vie ne soit à faire qu'une fois.
 *
 * Le process coûte ~400 Mo le temps de la sonde. Un plafond global borne ce que
 * plusieurs sondes simultanées peuvent lancer : le sélecteur de worktree du brouillon
 * fait changer le dossier sondé à chaque clic, et sans ce garde-fou chaque clic
 * lancerait son CLI en parallèle des précédents.
 */

const DEFAULT_TIMEOUT_MS = 20_000
const MAX_CONCURRENT = 2

interface ControlSessionOptions {
  /**
   * Toujours renseigné, jamais laissé au SDK : sa résolution interne cherche le
   * binaire du paquet plateforme `@anthropic-ai/claude-agent-sdk-<os>-<arch>`, que
   * la release ne transporte plus. Sans ce chemin la sonde échoue en quelques
   * millisecondes sur « Native CLI binary not found », et l'agent paraît absent
   * alors que son CLI est installé.
   */
  executable: () => Promise<string>
  cwd: string
  /** Préfixe de la sortie d'erreur relayée : `[claude <tag>]`. */
  tag: string
  timeoutMs?: number
  /** Options de lancement propres à la sonde, en plus du socle commun. */
  options?: Omit<Options, 'cwd' | 'abortController' | 'pathToClaudeCodeExecutable' | 'stderr'>
}

export async function withControlSession<T>(
  { executable, cwd, tag, timeoutMs = DEFAULT_TIMEOUT_MS, options }: ControlSessionOptions,
  fn: (session: Query) => Promise<T>,
): Promise<T> {
  const release = await acquire()
  const input = new AsyncQueue<SDKUserMessage>()
  const abort = new AbortController()
  let timedOut = false

  try {
    const session = query({
      prompt: input,
      options: {
        ...options,
        cwd,
        abortController: abort,
        pathToClaudeCodeExecutable: await executable(),
        // La sortie d'erreur du CLI est la seule explication d'une sonde ratée : la
        // jeter ne laisse au serveur qu'un 502 sans motif.
        stderr: (data) => process.stderr.write(`[claude ${tag}] ${data}`),
      },
    })

    const timer = setTimeout(() => {
      timedOut = true
      abort.abort()
    }, timeoutMs)
    try {
      return await fn(session)
    } catch (err) {
      // Le SDK ne dit que « Query closed before response received » quand on
      // l'abandonne : le lecteur du 502 doit savoir que c'est le délai qui a parlé.
      if (timedOut) {
        throw new Error(`Claude CLI did not answer within ${Math.round(timeoutMs / 1000)}s`)
      }
      throw err
    } finally {
      clearTimeout(timer)
      input.close()
      abort.abort()
    }
  } finally {
    release()
  }
}

/** Sémaphore minimal : les demandes au-delà du plafond attendent leur tour. */
let running = 0
const waiting: Array<() => void> = []

async function acquire(): Promise<() => void> {
  if (running >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => waiting.push(resolve))
  }
  running += 1
  return () => {
    running -= 1
    waiting.shift()?.()
  }
}
