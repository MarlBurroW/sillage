import { spawn, type ChildProcess } from 'node:child_process'
import { launchOf } from '../agents/launch.js'
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

/** Additional Grok account login through Grok launched in its home. Grok handles xAI exchanges, writes `auth.json` and refreshes it later; Sillage subsequently sees neither tokens nor keys. Device login uses `grok login --device-auth` (probed on 1.0.62): without a terminal it prints `https://accounts.x.ai/oauth2/device?user_code=…` and a code, waits for confirmation, then prints '✓ Signed in as <email>' and exits 0. Browser login is excluded for Codex's same reason: redirects target the unreachable server. API-key login uses ACP `xai.api_key`; Grok reads `XAI_API_KEY` and stores it in the home's `auth.json` (`store_api_key` in its source). */

/** Abandon pending logins after this timeout when nobody enters the code. */
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000

/** Time allowed for `grok login` to print its URL and code. */
const START_TIMEOUT_MS = 30_000

interface PendingLogin {
  child: ChildProcess
  verificationUrl: string
  userCode: string
  timer: NodeJS.Timeout
}

type LoginOutcome = { state: 'done' } | { state: 'failed'; error: string }

/** Removes CLI color and line-clearing sequences. */
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

  /** Device login returns URL and code as soon as Grok prints them, retaining the process until completion. Reuse in-progress logins for the same account. */
  async startDeviceCode(accountId: string): Promise<GrokLoginStatusDto> {
    if (this.pending.has(accountId)) return this.status(accountId)
    this.outcomes.delete(accountId)
    const home = this.homes.ensure(accountId)
    const launch = launchOf(await this.binary())
    const child = spawn(launch.command, [...launch.args, 'login', '--device-auth'], {
      cwd: home,
      env: this.env(home),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
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
          // Process died before printing its code: output explains why.
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

  /** API-key login: Grok writes the home's `auth.json` and responds immediately. */
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

  /** Rereads subscription plans, which may change after login. */
  async refresh(accountId: string): Promise<void> {
    const account = this.store.findById(accountId)
    if (!account?.authMode) return
    const usage = await readGrokBilling(await this.binary(), this.homes.ensure(accountId))
    this.store.setIdentity(accountId, { authMode: account.authMode, email: account.email, plan: usage.plan })
  }

  /** Logs out the home: `grok logout` revokes the session, then remove account `auth.json` regardless of Grok's result; only it and caches are account-specific. */
  async logout(accountId: string): Promise<void> {
    await this.cancel(accountId)
    const home = this.homes.ensure(accountId)
    const binary = await this.binary()
    await new Promise<void>((resolve) => {
      const launch = launchOf(binary)
      const child = spawn(launch.command, [...launch.args, 'logout'], { cwd: home, env: this.env(home), stdio: 'ignore', windowsHide: true })
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
    // Do not follow links: `rm` never enters symlink targets.
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
    // Read plans afterward: failures must not undo successful logins.
    await this.refresh(accountId).catch(() => {})
  }
}
