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

/** Additional Codex account login through an app-server launched in its home. Codex handles all OpenAI exchanges, writes `auth.json` and refreshes it later. Sillage subsequently sees neither tokens nor keys, only `account/read` information. Device codes are the only viable ChatGPT flow: browser login redirects to server-side `localhost:1455`, unreachable from the user's machine. Users must enable device login in ChatGPT security settings; Codex explains failures. Probed on 0.162.1: `account/login/start` returns URL and code before `auth.json` exists, followed by `account/login/completed`. */

/** Close waiting app-servers after this timeout when nobody enters the code. */
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

  /** Device-code login: returns user instructions and keeps the app-server open until Codex reports completion. Reuse existing in-progress logins for this account rather than duplicate them. */
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

  /** API-key login: Codex writes `auth.json` and responds immediately. */
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

  /** Rereads Codex account information from its home and stores it in the row. */
  async refresh(accountId: string): Promise<void> {
    const client = await this.open(accountId, () => {})
    try {
      this.store.setIdentity(accountId, await this.readIdentity(client))
    } finally {
      client.close()
    }
  }

  /** Logs out the home: Codex removes `auth.json`, and the row becomes pending again. */
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

  /** Cancels any ongoing login and removes the home on account deletion. */
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
    // Do not follow symlinks: only `auth.json` and Codex-created entries are real,
    // and `rm` does not descend into symlink targets.
    await rm(this.homes.path(accountId), { recursive: true, force: true })
  }

  /** Closes pending logins at startup and shutdown; none survive. */
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
        // App-server death while waiting for a code means login failed.
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
    // Bedrock is irrelevant: Sillage Codex accounts represent subscriptions or API keys.
    return { authMode: 'apiKey', email: null, planType: null }
  }
}
