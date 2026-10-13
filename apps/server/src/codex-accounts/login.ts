import { rm } from 'node:fs/promises'
import type { CodexLoginStatusDto } from '@sillage/protocol'
import type {
  AccountLoginCompletedNotification,
  GetAccountResponse,
  LoginAccountParams,
  LoginAccountResponse,
} from '@sillage/codex-bindings/v2'
import { CodexAppServerClient } from '../agents/codex/app-server-client.js'
import { CLIENT_INFO } from '../agents/codex/client-info.js'
import { agentProcessEnv } from '../agents/process-env.js'
import type { CodexAccountHomes } from './homes.js'
import type { CodexAccountIdentity, CodexAccountStore } from './store.js'

/**
 * Connexion d'un compte Codex supplémentaire, par l'app-server lancé dans son home.
 *
 * Tout passe par Codex : c'est lui qui mène l'échange avec OpenAI, écrit `auth.json`
 * dans le home du compte et le rafraîchira ensuite. Sillage ne voit ni jeton ni clé
 * après coup, seulement ce que `account/read` dit du compte.
 *
 * Le code d'appareil est le seul flux ChatGPT possible ici : le flux navigateur revient
 * sur `localhost:1455` du serveur, injoignable depuis le poste de l'utilisateur. Il
 * demande d'être activé dans les réglages de sécurité ChatGPT, ce que l'erreur de
 * Codex dira le cas échéant (sondé sur 0.162.1 : `account/login/start` rend l'URL et
 * le code sans que `auth.json` existe, puis `account/login/completed` tombe).
 */

/** Au-delà, l'app-server en attente est fermé : personne n'a saisi le code. */
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000

interface PendingLogin {
  client: CodexAppServerClient
  verificationUrl: string
  userCode: string
  timer: NodeJS.Timeout
}

type LoginOutcome = { state: 'done' } | { state: 'failed'; error: string }

export class CodexLoginService {
  private readonly pending = new Map<string, PendingLogin>()
  private readonly outcomes = new Map<string, LoginOutcome>()

  constructor(
    private readonly homes: CodexAccountHomes,
    private readonly store: CodexAccountStore,
    private readonly binary: () => Promise<string>,
  ) {}

  status(accountId: string): CodexLoginStatusDto {
    const pending = this.pending.get(accountId)
    if (pending) {
      return { state: 'pending', verificationUrl: pending.verificationUrl, userCode: pending.userCode, error: null }
    }
    const outcome = this.outcomes.get(accountId)
    if (outcome?.state === 'failed') return { state: 'failed', verificationUrl: null, userCode: null, error: outcome.error }
    if (outcome?.state === 'done') return { state: 'done', verificationUrl: null, userCode: null, error: null }
    return { state: 'idle', verificationUrl: null, userCode: null, error: null }
  }

  /**
   * Par code d'appareil : rend ce que l'utilisateur doit faire, et garde l'app-server
   * ouvert jusqu'à ce que Codex annonce la fin. Une connexion déjà en cours sur ce
   * compte est reprise telle quelle plutôt que redoublée.
   */
  async startDeviceCode(accountId: string): Promise<CodexLoginStatusDto> {
    const current = this.pending.get(accountId)
    if (current) return this.status(accountId)
    this.outcomes.delete(accountId)

    const client = await this.open(accountId, (method, params) => {
      if (method !== 'account/login/completed') return
      const completed = params as AccountLoginCompletedNotification
      void this.finish(accountId, completed.success ? null : (completed.error ?? 'Connexion refusée.'))
    })

    let started: LoginAccountResponse
    try {
      started = await client.call<LoginAccountResponse, 'account/login/start'>('account/login/start', {
        type: 'chatgptDeviceCode',
      } satisfies LoginAccountParams)
    } catch (err) {
      client.close()
      throw err
    }
    if (started.type !== 'chatgptDeviceCode') {
      client.close()
      throw new Error(`Codex a répondu par un flux « ${started.type} » au lieu du code d'appareil.`)
    }

    const timer = setTimeout(() => {
      void this.finish(accountId, 'Personne n’a saisi le code à temps : connexion abandonnée.')
    }, LOGIN_TIMEOUT_MS)
    this.pending.set(accountId, { client, verificationUrl: started.verificationUrl, userCode: started.userCode, timer })
    return this.status(accountId)
  }

  /** Par clé API : Codex l'écrit dans `auth.json` et répond tout de suite. */
  async loginWithApiKey(accountId: string, apiKey: string): Promise<void> {
    await this.cancel(accountId)
    const client = await this.open(accountId, () => {})
    try {
      await client.call<LoginAccountResponse, 'account/login/start'>('account/login/start', {
        type: 'apiKey',
        apiKey,
      } satisfies LoginAccountParams)
      this.store.setIdentity(accountId, await this.readIdentity(client))
      this.outcomes.set(accountId, { state: 'done' })
    } finally {
      client.close()
    }
  }

  /** Relit ce que Codex dit du compte dans son home, et le retient sur la ligne. */
  async refresh(accountId: string): Promise<void> {
    const client = await this.open(accountId, () => {})
    try {
      this.store.setIdentity(accountId, await this.readIdentity(client))
    } finally {
      client.close()
    }
  }

  /** Déconnecte le home : Codex retire son `auth.json`, la ligne redevient en attente. */
  async logout(accountId: string): Promise<void> {
    await this.cancel(accountId)
    const client = await this.open(accountId, () => {})
    try {
      await client.call('account/logout', undefined as never)
    } finally {
      client.close()
    }
    this.store.setIdentity(accountId, { authMode: null, email: null, planType: null })
    this.outcomes.delete(accountId)
  }

  /** Abandonne une connexion en cours, s'il y en a une, et efface le home à la suppression. */
  async cancel(accountId: string): Promise<void> {
    const pending = this.pending.get(accountId)
    if (!pending) return
    this.pending.delete(accountId)
    clearTimeout(pending.timer)
    pending.client.close()
  }

  async forget(accountId: string): Promise<void> {
    await this.cancel(accountId)
    this.outcomes.delete(accountId)
    // Sans suivre les liens : le home n'a de réel que `auth.json` et ce que Codex y a
    // écrit, et `rm` n'entre pas dans une cible de lien symbolique.
    await rm(this.homes.path(accountId), { recursive: true, force: true })
  }

  /** Ferme ce qui attend encore, au démarrage comme à l'arrêt : rien n'y survit. */
  async closeAll(): Promise<void> {
    for (const accountId of [...this.pending.keys()]) await this.cancel(accountId)
  }

  private async finish(accountId: string, error: string | null): Promise<void> {
    const pending = this.pending.get(accountId)
    if (!pending) return
    this.pending.delete(accountId)
    clearTimeout(pending.timer)
    try {
      if (error === null) {
        this.store.setIdentity(accountId, await this.readIdentity(pending.client))
        this.outcomes.set(accountId, { state: 'done' })
      } else {
        this.outcomes.set(accountId, { state: 'failed', error })
      }
    } catch (err) {
      this.outcomes.set(accountId, { state: 'failed', error: err instanceof Error ? err.message : String(err) })
    } finally {
      pending.client.close()
    }
  }

  private async open(
    accountId: string,
    onNotification: (method: string, params: unknown) => void,
  ): Promise<CodexAppServerClient> {
    const home = this.homes.ensure(accountId)
    const client = new CodexAppServerClient({
      binary: await this.binary(),
      cwd: home,
      env: agentProcessEnv({ CODEX_HOME: home }),
      onNotification,
      onServerRequest: () => Promise.reject(new Error('Aucune requête serveur attendue pendant une connexion.')),
      onExit: () => {
        // Un app-server qui meurt pendant l'attente du code : la connexion a échoué.
        if (this.pending.get(accountId)?.client === client) {
          void this.finish(accountId, "L'app-server Codex s'est arrêté avant la fin de la connexion.")
        }
      },
    })
    try {
      await client.initialize(CLIENT_INFO)
    } catch (err) {
      client.close()
      throw err
    }
    return client
  }

  private async readIdentity(client: CodexAppServerClient): Promise<CodexAccountIdentity> {
    const read = await client.call<GetAccountResponse, 'account/read'>('account/read', { refreshToken: false })
    const account = read.account
    if (!account) return { authMode: null, email: null, planType: null }
    if (account.type === 'chatgpt') return { authMode: 'chatgpt', email: account.email, planType: account.planType }
    // Bedrock n'a pas de place ici : un compte Codex de Sillage est un abonnement ou une clé.
    return { authMode: 'apiKey', email: null, planType: null }
  }
}
