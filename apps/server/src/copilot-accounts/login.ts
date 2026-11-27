import { spawn, type ChildProcess } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { CopilotLoginStatusDto } from '@sillage/protocol'
import { launchOf } from '../agents/launch.js'
import { COPILOT_ISOLATION_ENV, copilotProcessEnv } from '../agents/copilot/launch.js'
import { copilotIdentity, type CopilotAccountHomes } from './homes.js'
import type { CopilotAccountStore } from './store.js'

/**
 * Additional Copilot account sign-in through `copilot login --device-code` run in the account's
 * home (probed on 1.0.116). Without a terminal it prints "To authenticate, visit
 * https://github.com/login/device and enter code XXXX-XXXX", waits for the user, writes the token
 * (keychain, or `config.json` with the plain-text consent `CopilotAccountHomes` grants) and
 * exits. The browser flow is excluded for the reason Codex and Grok exclude theirs: its callback
 * lands on the server's loopback. Copilot has no logout command outside its interactive
 * `/logout`, so signing out removes the home's `config.json`.
 */

/** Abandon pending logins after this timeout when nobody enters the code. */
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000

/** Time allowed for `copilot login` to print its URL and code. */
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

/** Last meaningful lines of the CLI's output, as the reason for a failure. */
function tail(output: string): string {
  return output.trim().split('\n').filter((line) => !/^(Failed to open browser|Failed to copy to clipboard|Waiting for authorization)/.test(line.trim())).slice(-2).join(' ')
}

export class CopilotLoginService {
  private readonly pending = new Map<string, PendingLogin>()
  private readonly outcomes = new Map<string, LoginOutcome>()

  constructor(
    private readonly homes: CopilotAccountHomes,
    private readonly store: CopilotAccountStore,
    private readonly binary: () => Promise<string>,
  ) {}

  status(accountId: string): CopilotLoginStatusDto {
    const pending = this.pending.get(accountId)
    if (pending) {
      return { state: 'pending', verificationUrl: pending.verificationUrl, userCode: pending.userCode, error: null }
    }
    const outcome = this.outcomes.get(accountId)
    if (outcome?.state === 'failed') return { state: 'failed', verificationUrl: null, userCode: null, error: outcome.error }
    if (outcome?.state === 'done') return { state: 'done', verificationUrl: null, userCode: null, error: null }
    return { state: 'idle', verificationUrl: null, userCode: null, error: null }
  }

  /** Returns the URL and code as soon as Copilot prints them, keeping the process until the user confirms. Reuses a login in progress for the same account. */
  async startDeviceCode(accountId: string): Promise<CopilotLoginStatusDto> {
    if (this.pending.has(accountId)) return this.status(accountId)
    this.outcomes.delete(accountId)
    const home = this.homes.ensure(accountId)
    const launch = launchOf(await this.binary())
    const child = spawn(launch.command, [...launch.args, 'login', '--device-code'], {
      cwd: home,
      // `BROWSER=true`: Copilot would otherwise try to open a browser on the server.
      env: copilotProcessEnv({ ...COPILOT_ISOLATION_ENV, COPILOT_HOME: home, BROWSER: 'true' }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    let output = ''
    await new Promise<void>((resolve, reject) => {
      const startTimer = setTimeout(() => {
        child.kill()
        reject(new Error('Copilot did not print a device code in time.'))
      }, START_TIMEOUT_MS)
      const onData = (chunk: Buffer) => {
        output += plain(chunk.toString())
        if (this.pending.has(accountId)) return
        const found = /(https:\/\/\S+\/login\/device)\S*\s+and enter (?:the )?code\s+([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(output)
        if (!found) return
        clearTimeout(startTimer)
        const timer = setTimeout(() => {
          this.fail(accountId, 'Nobody entered the code in time: sign-in abandoned.')
        }, LOGIN_TIMEOUT_MS)
        this.pending.set(accountId, { child, verificationUrl: found[1]!, userCode: found[2]!, timer })
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
          reject(new Error(tail(output) || `copilot login exited with ${code}.`))
          return
        }
        const identity = copilotIdentity(home)
        if (code === 0 && identity) this.finish(accountId, identity)
        else this.fail(accountId, tail(output) || `copilot login exited with ${code}.`)
      })
    })
    return this.status(accountId)
  }

  /** Forgets the home's sign-in. A token Copilot kept in a keychain stays there, unreachable from this home. */
  async logout(accountId: string): Promise<void> {
    await this.cancel(accountId)
    await rm(join(this.homes.path(accountId), 'config.json'), { force: true })
    this.store.setIdentity(accountId, null)
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
    // `rm` never enters symlink targets: the user's shared entries stay.
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

  private finish(accountId: string, identity: { login: string; host: string }): void {
    const pending = this.pending.get(accountId)
    if (!pending) return
    this.pending.delete(accountId)
    clearTimeout(pending.timer)
    this.store.setIdentity(accountId, identity)
    this.outcomes.set(accountId, { state: 'done' })
  }
}
