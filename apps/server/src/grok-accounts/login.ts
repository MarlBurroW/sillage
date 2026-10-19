import { spawn, type ChildProcess } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { GrokLoginStatusDto } from '@sillage/protocol'
import { AcpClient } from '../agents/acp/client.js'
import { CLIENT_INFO } from '../agents/codex/client-info.js'
import { readGrokBilling } from '../agents/grok/billing.js'
import { GROK_ISOLATION_ENV } from '../agents/grok/launch.js'
import { agentProcessEnv } from '../agents/process-env.js'
import type { GrokAccountHomes } from './homes.js'
import type { GrokAccountStore } from './store.js'

/**
 * Connexion d'un compte Grok supplémentaire, par Grok lancé dans son home.
 *
 * Tout passe par Grok : c'est lui qui mène l'échange avec xAI, écrit `auth.json` dans le
 * home du compte et le rafraîchira ensuite. Sillage ne voit ni jeton ni clé après coup.
 *
 * Par code d'appareil, `grok login --device-auth` (sondé sur 1.0.62) : sans terminal, il
 * écrit l'URL `https://accounts.x.ai/oauth2/device?user_code=…` et le code, attend la
 * confirmation, puis « ✓ Signed in as <courriel> » et rend 0. Le flux navigateur est
 * écarté pour la même raison que chez Codex : son retour vise le serveur, injoignable.
 *
 * Par clé API, la méthode ACP `xai.api_key` : Grok lit `XAI_API_KEY` et l'enregistre dans
 * l'`auth.json` du home (`store_api_key` dans ses sources).
 */

/** Au-delà, la connexion en attente est abandonnée : personne n'a saisi le code. */
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000

/** Ce que `grok login` met à écrire l'URL et le code avant qu'on renonce. */
const START_TIMEOUT_MS = 30_000

interface PendingLogin {
  child: ChildProcess
  verificationUrl: string
  userCode: string
  timer: NodeJS.Timeout
}

type LoginOutcome = { state: 'done' } | { state: 'failed'; error: string }

/** Retire les séquences de couleur et d'effacement de ligne qu'écrit le CLI. */
function plain(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
}

export class GrokLoginService {
  private readonly pending = new Map<string, PendingLogin>()
  private readonly outcomes = new Map<string, LoginOutcome>()

  constructor(
    private readonly homes: GrokAccountHomes,
    private readonly store: GrokAccountStore,
    private readonly binary: () => Promise<string>,
  ) {}

  status(accountId: string): GrokLoginStatusDto {
    const pending = this.pending.get(accountId)
    if (pending) {
      return { state: 'pending', verificationUrl: pending.verificationUrl, userCode: pending.userCode, error: null }
    }
    const outcome = this.outcomes.get(accountId)
    if (outcome?.state === 'failed') return { state: 'failed', verificationUrl: null, userCode: null, error: outcome.error }
    if (outcome?.state === 'done') return { state: 'done', verificationUrl: null, userCode: null, error: null }
    return { state: 'idle', verificationUrl: null, userCode: null, error: null }
  }

  private env(home: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return agentProcessEnv({ ...GROK_ISOLATION_ENV, GROK_HOME: home, ...extra })
  }

  /**
   * Par code d'appareil : rend l'URL et le code dès que Grok les a écrits, et garde le
   * process jusqu'à sa fin. Une connexion déjà en cours sur ce compte est reprise.
   */
  async startDeviceCode(accountId: string): Promise<GrokLoginStatusDto> {
    if (this.pending.has(accountId)) return this.status(accountId)
    this.outcomes.delete(accountId)
    const home = this.homes.ensure(accountId)
    const child = spawn(await this.binary(), ['login', '--device-auth'], {
      cwd: home,
      env: this.env(home),
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let output = ''
    await new Promise<void>((resolve, reject) => {
      const startTimer = setTimeout(() => {
        child.kill()
        reject(new Error("Grok n'a pas donné de code d'appareil à temps."))
      }, START_TIMEOUT_MS)
      const onData = (chunk: Buffer) => {
        output += plain(chunk.toString())
        if (this.pending.has(accountId)) return
        const url = /https:\/\/\S+user_code=([A-Z0-9-]+)\S*/.exec(output)
        if (!url) return
        clearTimeout(startTimer)
        const timer = setTimeout(() => {
          this.fail(accountId, 'Personne n’a saisi le code à temps : connexion abandonnée.')
        }, LOGIN_TIMEOUT_MS)
        this.pending.set(accountId, { child, verificationUrl: url[0], userCode: url[1]!, timer })
        resolve()
      }
      child.stdout!.on('data', onData)
      child.stderr!.on('data', onData)
      child.on('error', (err) => {
        clearTimeout(startTimer)
        reject(err)
      })
      child.on('exit', (code) => {
        clearTimeout(startTimer)
        const pending = this.pending.get(accountId)
        if (!pending || pending.child !== child) {
          // Mort avant d'avoir donné son code : la raison est dans ce qu'il a écrit.
          reject(new Error(output.trim().split('\n').slice(-2).join(' ') || `grok login a rendu ${code}.`))
          return
        }
        if (code === 0 && this.homes.connected(accountId)) {
          const email = /Signed in as (\S+)/.exec(output)?.[1] ?? null
          void this.finish(accountId, email)
        } else {
          this.fail(accountId, output.trim().split('\n').slice(-2).join(' ') || `grok login a rendu ${code}.`)
        }
      })
    })
    return this.status(accountId)
  }

  /** Par clé API : Grok l'écrit dans l'`auth.json` du home, et répond tout de suite. */
  async loginWithApiKey(accountId: string, apiKey: string): Promise<void> {
    await this.cancel(accountId)
    const home = this.homes.ensure(accountId)
    const client = new AcpClient({
      label: 'grok',
      binary: await this.binary(),
      args: ['agent', '--no-leader', 'stdio'],
      cwd: home,
      env: this.env(home, { XAI_API_KEY: apiKey }),
    })
    try {
      await client.initialize(CLIENT_INFO)
      await client.request('authenticate', { methodId: 'xai.api_key' })
    } finally {
      client.close()
    }
    if (!this.homes.connected(accountId)) {
      throw new Error("Grok a accepté la clé sans l'enregistrer dans le home du compte.")
    }
    this.store.setIdentity(accountId, { authMode: 'apiKey', email: null, plan: null })
    this.outcomes.set(accountId, { state: 'done' })
  }

  /** Relit la formule de l'abonnement, qui peut changer après la connexion. */
  async refresh(accountId: string): Promise<void> {
    const account = this.store.findById(accountId)
    if (!account?.authMode) return
    const usage = await readGrokBilling(await this.binary(), this.homes.ensure(accountId))
    this.store.setIdentity(accountId, { authMode: account.authMode, email: account.email, plan: usage.plan })
  }

  /**
   * Déconnecte le home : `grok logout` révoque la session, puis l'`auth.json` du compte,
   * le seul fichier qui lui soit propre avec ses caches, est retiré quoi que dise Grok.
   */
  async logout(accountId: string): Promise<void> {
    await this.cancel(accountId)
    const home = this.homes.ensure(accountId)
    const binary = await this.binary()
    await new Promise<void>((resolve) => {
      const child = spawn(binary, ['logout'], { cwd: home, env: this.env(home), stdio: 'ignore' })
      const timer = setTimeout(() => child.kill(), 20_000)
      child.on('exit', () => { clearTimeout(timer); resolve() })
      child.on('error', () => { clearTimeout(timer); resolve() })
    })
    await rm(join(home, 'auth.json'), { force: true })
    this.store.setIdentity(accountId, { authMode: null, email: null, plan: null })
    this.outcomes.delete(accountId)
  }

  async cancel(accountId: string): Promise<void> {
    const pending = this.pending.get(accountId)
    if (!pending) return
    this.pending.delete(accountId)
    clearTimeout(pending.timer)
    pending.child.kill()
  }

  async forget(accountId: string): Promise<void> {
    await this.cancel(accountId)
    this.outcomes.delete(accountId)
    // Sans suivre les liens : `rm` n'entre pas dans la cible d'un lien symbolique.
    await rm(this.homes.path(accountId), { recursive: true, force: true })
  }

  async closeAll(): Promise<void> {
    for (const accountId of [...this.pending.keys()]) await this.cancel(accountId)
  }

  private fail(accountId: string, error: string): void {
    const pending = this.pending.get(accountId)
    if (!pending) return
    this.pending.delete(accountId)
    clearTimeout(pending.timer)
    pending.child.kill()
    this.outcomes.set(accountId, { state: 'failed', error })
  }

  private async finish(accountId: string, email: string | null): Promise<void> {
    const pending = this.pending.get(accountId)
    if (!pending) return
    this.pending.delete(accountId)
    clearTimeout(pending.timer)
    this.store.setIdentity(accountId, { authMode: 'grok', email, plan: null })
    this.outcomes.set(accountId, { state: 'done' })
    // La formule se lit après coup : son échec ne défait pas une connexion réussie.
    await this.refresh(accountId).catch(() => {})
  }
}
