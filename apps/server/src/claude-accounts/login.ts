import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type IPty } from 'node-pty'
import { launchOf } from '../agents/launch.js'
import { claudeSecretKind, type ClaudeLoginStatusDto } from '@sillage/protocol'
import { agentProcessEnv } from '../agents/process-env.js'
import type { ClaudeAccountStore } from './store.js'

/** Guided Claude subscription login through `claude setup-token` in a pseudo-terminal. No nonterminal subscription flow exists: setup-token opens browsers or prints authorization URLs, waits for pasted codes, then prints tokens. Probed on 2.1.296 under `script`: URLs use OSC 8 links followed by 'Paste code here if prompted'; wrong codes yield 'OAuth error: Invalid code … Press Enter to retry'; configuration directories remain untouched. Sillage mirrors this dialogue. Use disposable configuration directories to avoid reading or writing host authentication; tokens exist only in memory until encrypted into accounts created at that point. One login is enough: the same token feeds sessions and the usage gauge (see `ClaudeUsageReader.readForToken`). A second `claude auth login` once supplied the gauge, at the cost of a second page and code. */

/** Close waiting CLIs after this timeout when nobody pasted codes. */
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000
/** Time allowed for Anthropic code verification and token output. */
const CODE_TIMEOUT_MS = 3 * 60 * 1000
/** Separate code input from validating Enter so CLIs do not read them as one paste. */
const ENTER_DELAY_MS = 300
/** CLI output retained for explaining failures, with tokens redacted. */
const DIAGNOSTIC_TAIL = 400
const URL_PATTERN = /https:\/\/[a-z.]*claude\.com\/[^\s\x07\x1b"']*oauth\/authorize\?[^\s\x07\x1b"']+/g
const TOKEN_PREFIX = 'sk-ant-oat01-'
const TOKEN_CHARS = /[A-Za-z0-9_-]/
/** Setup tokens are roughly a hundred characters; shorter values are truncated. */
const TOKEN_MIN_LENGTH = 60
/** Patterns stop where CLIs resume control: 'Press Enter to retry', 'Retrying…'. */
const ERROR_PATTERN = /OAuth\s*error:\s*(.*?)(?=[\s\x00]*(?:Press\s*Enter|Retrying|$))/i
/** Opener the CLI runs instead of a browser. setup-token opens one itself with a localhost-callback URL besides printing the manual one: on Desktop that tab appeared on the user's machine, asked for nothing, and consumed the flow, so the code from Sillage's own link was then refused (October 2026). `true` does nothing and exits 0; Windows has no such command, and an automatic completion there is still caught (see `consume`). */
const NO_BROWSER: Record<string, string> = process.platform === 'win32' ? {} : { BROWSER: 'true' }

interface Login {
  ownerId: string
  /** Account label to create. */
  label: string
  pty: IPty
  configDir: string
  /** Accumulated terminal-cleaned output for reading prompts and tokens. */
  output: string
  /** Same output raw, retaining full URLs inside link targets. */
  raw: string
  status: ClaudeLoginStatusDto
  timer: NodeJS.Timeout
  /** Current code-verification timeout, when present. */
  checking: { since: number; timer: NodeJS.Timeout } | null
  /** Set by `finish`: subsequent CLI exits are expected. */
  closing: boolean
}

/** Authorization URLs read from raw output rather than cleaned text. OSC 8 targets hold complete URLs while visible text wraps at terminal width. Cleaning first discarded targets and left incomplete `%3`, reencoded as `%253`, producing invalid OAuth requests (observed 2026-10-13). Keep longest occurrences only when reaching final `state` parameters. */
export function authUrlFrom(raw: string): string | null {
  const complete = [...raw.matchAll(URL_PATTERN)].map((match) => match[0]).filter((url) => /[?&]state=[A-Za-z0-9_-]+$/.test(url))
  // Keep the latest: codes from other flows cause CLIs to reopen authorization
  // with new URLs that must be displayed.
  return complete[complete.length - 1] ?? null
}

/** Authorization URL `state` distinguishing flows. */
function stateOf(url: string | null): string | null {
  return url ? (/[?&]state=([A-Za-z0-9_-]+)/.exec(url)?.[1] ?? null) : null
}

/** Replaces terminal control (colors, cursor movements, OSC 8 links) with markers and removes carriage returns. Markers rather than deletion preserve boundaries between colored tokens and subsequent text when colors reset. */
const MARK = '\x00'
export function plain(chunk: string): string {
  return chunk
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, MARK)
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, MARK)
    .replace(/\x1b[()][A-Za-z0-9]/g, MARK)
    .replace(/[\x0e\x0f\x07\r]/g, '')
}

/** Reassembles printed tokens across line wraps. Ink wraps hundred-character tokens within boxes; follow prefixes across spaces/newlines until other characters, including color-reset markers. Longest wins because redraws repeat tokens, sometimes truncated. */
export function tokenFrom(output: string): string | null {
  let best: string | null = null
  for (let at = output.indexOf(TOKEN_PREFIX); at !== -1; at = output.indexOf(TOKEN_PREFIX, at + 1)) {
    let token = TOKEN_PREFIX
    for (let i = at + TOKEN_PREFIX.length; i < output.length; i += 1) {
      const char = output[i]!
      if (TOKEN_CHARS.test(char)) token += char
      else if (char === ' ' || char === '\n' || char === '\t') continue
      else break
    }
    if (token.length >= TOKEN_MIN_LENGTH && (best === null || token.length > best.length)) best = token
  }
  return best
}

/** Readable token-free output tail shown when CLIs fail to finish. */
function diagnostic(output: string): string {
  return output
    .replace(/sk-ant-oat01-[A-Za-z0-9_-]*/g, 'sk-ant-oat01-…')
    // Remove markers and remaining control bytes so errors are readable and serializable.
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
    .slice(-DIAGNOSTIC_TAIL)
}

export class ClaudeLoginService {
  private readonly logins = new Map<string, Login>()

  constructor(
    private readonly store: ClaudeAccountStore,
    private readonly binary: () => Promise<string>,
  ) {}

  status(ownerId: string, loginId: string): ClaudeLoginStatusDto | undefined {
    const login = this.logins.get(loginId)
    return login && login.ownerId === ownerId ? login.status : undefined
  }

  /** Starts CLIs and waits for URLs or earlier failures. */
  async start(ownerId: string, label: string): Promise<ClaudeLoginStatusDto> {
    const loginId = randomUUID()
    const { pty, configDir } = await this.spawnCli()
    const login: Login = {
      ownerId,
      label,
      pty,
      configDir,
      output: '',
      raw: '',
      status: { loginId, state: 'starting', authUrl: null, error: null, account: null },
      timer: setTimeout(() => this.finish(loginId, 'Personne n’a collé le code à temps : connexion abandonnée.'), LOGIN_TIMEOUT_MS),
      checking: null,
      closing: false,
    }
    this.logins.set(loginId, login)
    this.attach(loginId, pty)

    // URLs arrive within a second; longer means CLIs failed to start or
    // printed something else; output is the only clue.
    await this.until(loginId, (current) => current.status.state !== 'starting', 20_000).catch(() => {
      this.finish(loginId, `Le CLI n'a pas imprimé d'URL d'autorisation : ${login.output.trim().slice(-300) || 'aucune sortie'}`)
    })
    return login.status
  }

  /** Writes codes to CLIs; read subsequent progress through `status`. Tokens normally arrive in seconds but exchanges may stall, and three-minute HTTP waits would be cut off. Failures retain output tails, the only clue to expected input. */
  submitCode(ownerId: string, loginId: string, code: string): ClaudeLoginStatusDto | undefined {
    const login = this.logins.get(loginId)
    if (!login || login.ownerId !== ownerId) return undefined
    if (login.status.state === 'done' || login.status.state === 'checking' || login.status.state === 'starting') {
      return login.status
    }

    // After rejection, CLIs await Enter to reopen prompts (probed): send it before
    // the next code. Strip pasted whitespace and newlines,
    // which the CLI would reject unchanged.
    if (login.status.state === 'failed') login.pty.write('\r')
    login.status = { ...login.status, state: 'checking', error: null }
    const since = login.output.length
    // Write code and Enter separately with a delay: together, CLIs treat long codes
    // as pastes including Enter, leaving nothing validated
    // and screens silent. Probed on 2.1.296: 91 characters plus Enter in one write
    // produced no reaction; two writes submitted successfully. Short codes worked,
    // explaining successful invalid-code trials.
    login.pty.write(code.replace(/\s+/g, ''))
    setTimeout(() => {
      if (login.checking) login.pty.write('\r')
    }, ENTER_DELAY_MS)

    const timer = setTimeout(() => {
      if (!login.checking) return
      login.checking = null
      login.status = {
        ...login.status,
        state: 'failed',
        error: `Le CLI n'a pas conclu en trois minutes. Sa sortie : ${diagnostic(login.output.slice(since))}`,
      }
    }, CODE_TIMEOUT_MS)
    login.checking = { since, timer }
    // Streams may already have completed between writing and waiting.
    this.settle(loginId)
    return login.status
  }

  /** Fresh CLI inside its own disposable directory. */
  private async spawnCli(): Promise<{ pty: IPty; configDir: string }> {
    const configDir = await mkdtemp(join(tmpdir(), 'sillage-claude-login-'))
    const launch = launchOf(await this.binary())
    const pty = spawn(launch.command, [...launch.args, 'setup-token'], {
      name: 'xterm-256color',
      // Wide terminals keep URLs and tokens on fewer lines; both are reassembled anyway.
      cols: 400,
      rows: 40,
      cwd: configDir,
      env: agentProcessEnv({ CLAUDE_CONFIG_DIR: configDir, TERM: 'xterm-256color', ...NO_BROWSER }) as Record<string, string>,
    })
    return { pty, configDir }
  }

  /** Attaches CLI output and exit listeners, ignoring replaced CLI instances. */
  private attach(loginId: string, pty: IPty): void {
    pty.onData((data) => {
      if (this.logins.get(loginId)?.pty === pty) this.consume(loginId, data)
    })
    pty.onExit(({ exitCode }) => {
      const current = this.logins.get(loginId)
      if (!current || current.pty !== pty || current.closing || current.status.state === 'done') return
      this.exited(loginId, exitCode)
    })
  }

  /** CLI exited without finishing: setup-token stays alive after rejected codes, so an exit is the end. A token printed just before exiting still counts. */
  private exited(loginId: string, exitCode: number): void {
    const login = this.logins.get(loginId)
    if (!login) return
    if (this.adoptToken(loginId)) return
    void this.finish(
      loginId,
      login.status.error ??
        `claude setup-token s'est arrêté (code ${exitCode}) sans conclure. Sa sortie : ${diagnostic(login.output)}`,
    )
  }

  async cancel(ownerId: string, loginId: string): Promise<boolean> {
    const login = this.logins.get(loginId)
    if (!login || login.ownerId !== ownerId) return false
    await this.finish(loginId, 'Connexion annulée.')
    this.logins.delete(loginId)
    return true
  }

  /** Closes remaining pending logins on shutdown; none survive. */
  async closeAll(): Promise<void> {
    for (const loginId of [...this.logins.keys()]) await this.finish(loginId, 'Serveur arrêté.')
  }

  private consume(loginId: string, data: string): void {
    const login = this.logins.get(loginId)
    if (!login) return
    // Clean accumulated output rather than chunks: control sequences split across
    // chunks would otherwise leave fragments in parsed text.
    login.raw += data
    login.output = plain(login.raw)
    const url = authUrlFrom(login.raw)
    if (login.status.state === 'starting' && url) {
      // After restarts, screens retain failures including reasons and new URLs;
      // only submitting another code clears them.
      login.status = { ...login.status, state: login.status.error ? 'failed' : 'waiting_code', authUrl: url }
    }
    if (login.checking) this.settle(loginId)
    // Also outside verification: a flow completed through the browser callback prints
    // its token without any pasted code.
    else this.adoptToken(loginId)
    // Also outside verification: reopened flows change URLs that screens must follow.
    if (url && url !== login.status.authUrl) login.status = { ...login.status, authUrl: url }
  }

  /** During code verification, printed tokens create accounts; rejections restore waiting. Parse only output since submission to avoid previous rejections. */
  private settle(loginId: string): void {
    const login = this.logins.get(loginId)
    if (!login?.checking) return
    if (this.adoptToken(loginId)) return
    const since = login.output.slice(login.checking.since)
    const refused = ERROR_PATTERN.exec(since)?.[1]?.replace(new RegExp(MARK, 'g'), '')
    // Codes from other pages silently reopen flows with new URLs (observed 2026-10-13
    // with codes from previous attempts). Explain and display the new URL:
    // users only need reopen it.
    const reopened = authUrlFrom(login.raw)
    const restarted = reopened !== null && stateOf(reopened) !== stateOf(login.status.authUrl)
    if (!refused && !restarted) return

    clearTimeout(login.checking.timer)
    login.checking = null
    if (restarted && !refused) {
      login.status = {
        ...login.status,
        state: 'failed',
        authUrl: reopened,
        error:
          "Ce code vient d'une autre page d'autorisation : le CLI en a ouvert une nouvelle. Rouvre le lien ci-dessus et colle le code qu'il affiche.",
      }
    } else {
      login.status = { ...login.status, state: 'failed', error: (refused ?? '').trim() || 'Code refusé.' }
    }
  }

  /** Creates the account once the CLI has printed its token, whichever way the flow completed. The whole output is searched: the URL and prompts never contain the token prefix. */
  private adoptToken(loginId: string): boolean {
    const login = this.logins.get(loginId)
    if (!login || login.status.state === 'done') return false
    const token = tokenFrom(login.output)
    if (!token || claudeSecretKind(token) !== 'oauth') return false
    if (login.checking) {
      clearTimeout(login.checking.timer)
      login.checking = null
    }
    // Labels may become occupied meanwhile; suffixes are better than lost tokens.
    const label = this.store.labelFree(login.ownerId, login.label) ? login.label : `${login.label} ${new Date().toLocaleDateString('fr-FR')}`
    const account = this.store.create(login.ownerId, label, token)
    login.status = { ...login.status, state: 'done', error: null, account }
    void this.finish(loginId, null)
    return true
  }

  private async finish(loginId: string, error: string | null): Promise<void> {
    const login = this.logins.get(loginId)
    if (!login) return
    login.closing = true
    clearTimeout(login.timer)
    if (login.checking) {
      clearTimeout(login.checking.timer)
      login.checking = null
    }
    if (error !== null && login.status.state !== 'done') {
      login.status = { ...login.status, state: 'failed', error }
    }
    // Delete directories only once CLIs exit: they still write during shutdown,
    // and premature deletion recreated partial directories.
    const exited = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000)
      login.pty.onExit(() => {
        clearTimeout(timer)
        resolve()
      })
    })
    try {
      login.pty.kill()
    } catch {
      // Already dead, the desired outcome.
    }
    await exited
    await rm(login.configDir, { recursive: true, force: true })
    // Retain state long enough for screens to reread, then discard it.
    setTimeout(() => this.logins.delete(loginId), 5 * 60 * 1000).unref()
  }

  private until(loginId: string, done: (login: Login) => boolean, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const started = Date.now()
      const tick = () => {
        const login = this.logins.get(loginId)
        if (!login) return reject(new Error('Connexion disparue.'))
        if (done(login)) return resolve()
        if (Date.now() - started > timeoutMs) return reject(new Error('Délai dépassé.'))
        setTimeout(tick, 100)
      }
      tick()
    })
  }
}
