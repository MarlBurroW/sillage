import { spawn, type ChildProcess } from 'node:child_process'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { eq } from 'drizzle-orm'
import { conversations, type Db } from '@sillage/db'
import {
  BROWSER_MCP_SERVER_NAME,
  type BrowserClientMessage,
  type BrowserDto,
  type BrowserServerMessage,
  type BrowserTabDto,
  type McpServer,
} from '@sillage/protocol'
import { resolveBinary } from '../agents/cli-binary.js'
import type { Config } from '../config.js'
import { processOrigins } from '../services/origins.js'
import { CdpConnection } from './cdp.js'
import { BrowserInstall } from './engine.js'

/** Each browser costs a few hundred MB; past this, a new one is refused with an explanation. */
const MAX_BROWSERS = 6
/** Closed after this long with neither the agent connected nor anyone watching. */
const IDLE_MS = 10 * 60_000
const LAUNCH_TIMEOUT_MS = 20_000
/** Path prefix of the agent's CDP proxy; authenticated by its token, not a session cookie. */
export const BROWSER_CDP_PREFIX = '/api/browser-cdp/'

interface Viewer {
  send: (message: BrowserServerMessage) => void
}

interface RunningBrowser {
  conversationId: string
  process: ChildProcess
  profile: string
  /** `ws://127.0.0.1:<port>/devtools/browser/<id>`, the endpoint agents are proxied to. */
  endpoint: string
  cdp: CdpConnection
  startedAt: number
  tabs: Map<string, BrowserTabDto>
  /** The tab the agent touched last; the live view follows it unless a viewer picked another. */
  activeTargetId: string | null
  agents: number
  viewers: Set<Viewer>
  /** Viewer's explicit choice; null follows the agent. */
  pinnedTargetId: string | null
  /** Target and flat session currently screencast. */
  cast: { targetId: string; sessionId: string } | null
  lastActivity: number
}

/**
 * Agent browsers, one Chromium per conversation (isolation: a session never sees another's tabs
 * or cookies). Launched lazily when the agent's Playwright MCP first connects, closed when idle.
 */
export class BrowserManager {
  readonly install: BrowserInstall
  private readonly running = new Map<string, RunningBrowser>()
  private readonly launching = new Map<string, Promise<RunningBrowser>>()
  private readonly key: Buffer
  private sweeper: NodeJS.Timeout | null = null
  private titles: NodeJS.Timeout | null = null

  constructor(private readonly db: Db, private readonly config: Config) {
    const root = join(config.paths.data, 'browser')
    this.install = new BrowserInstall(root)
    this.key = loadKey(join(root, 'key'))
    this.sweeper = setInterval(() => this.sweep(), 60_000)
    this.sweeper.unref()
    // Watched browsers get their titles refreshed for the tab list.
    this.titles = setInterval(() => {
      for (const browser of this.running.values()) {
        if (browser.viewers.size > 0) this.refreshTabs(browser).then((changed) => { if (changed) this.broadcastState(browser) }).catch(ignore)
      }
    }, 2000)
    this.titles.unref()
  }

  private get root(): string {
    return join(this.config.paths.data, 'browser')
  }

  /**
   * Token in the agent's CDP URL. Derived from a key on disk rather than random per launch, so a
   * CLI's MCP server keeps working when the daemon restarts underneath it.
   */
  tokenFor(conversationId: string): string {
    return createHmac('sha256', this.key).update(conversationId).digest('hex')
  }

  verify(conversationId: string, token: string): boolean {
    const expected = Buffer.from(this.tokenFor(conversationId))
    const given = Buffer.from(token)
    return expected.length === given.length && timingSafeEqual(expected, given)
  }

  /** The MCP server handed to a session whose `browser` family is on; null when not installed. */
  mcpServerFor(conversationId: string): McpServer | null {
    const entry = this.install.mcpEntry()
    if (!entry || !this.install.engine()) return null
    const host = ['0.0.0.0', '::', ''].includes(this.config.server.host) ? '127.0.0.1' : this.config.server.host
    const authority = host.includes(':') ? `[${host}]` : host
    const endpoint = `ws://${authority}:${this.config.server.port}${BROWSER_CDP_PREFIX}${conversationId}?token=${this.tokenFor(conversationId)}`
    return {
      id: 'builtin:browser',
      name: BROWSER_MCP_SERVER_NAME,
      enabled: true,
      projectId: null,
      transport: {
        type: 'stdio',
        command: process.execPath,
        // Screenshots and traces go to the session's temporary folder rather than the repository.
        args: [entry, '--cdp-endpoint', endpoint, '--output-dir', join(this.root, 'output', conversationId)],
        env: {},
      },
      createdAt: 0,
      updatedAt: 0,
    }
  }

  /** Tab titles are reread here: Chromium reports URL changes as events, but not title changes. */
  async list(): Promise<BrowserDto[]> {
    const browsers = [...this.running.values()]
    await Promise.all(browsers.map((browser) => this.refreshTabs(browser)))
    return browsers.map((browser) => this.toDto(browser))
  }

  private async refreshTabs(browser: RunningBrowser): Promise<boolean> {
    const result = await browser.cdp.send<{ targetInfos: { targetId: string; type: string; url: string; title: string }[] }>('Target.getTargets').catch(() => null)
    if (!result) return false
    let changed = false
    for (const info of result.targetInfos) {
      const tab = browser.tabs.get(info.targetId)
      if (info.type !== 'page' || !tab || (tab.title === info.title && tab.url === info.url)) continue
      browser.tabs.set(info.targetId, { targetId: info.targetId, url: info.url, title: info.title })
      changed = true
    }
    return changed
  }

  /** The agent's DevTools endpoint, launching the browser if needed. */
  async agentEndpoint(conversationId: string): Promise<string> {
    const browser = await this.ensure(conversationId)
    return browser.endpoint
  }

  agentConnected(conversationId: string, connected: boolean): void {
    const browser = this.running.get(conversationId)
    if (!browser) return
    browser.agents = Math.max(0, browser.agents + (connected ? 1 : -1))
    browser.lastActivity = Date.now()
    this.broadcastState(browser)
  }

  /** A person opened the live view. Does not launch a browser: watching an absent one shows an empty state. */
  addViewer(conversationId: string, send: Viewer['send']): { handle: (message: BrowserClientMessage) => Promise<void>; detach: () => void } {
    const viewer: Viewer = { send }
    const attach = () => {
      const browser = this.running.get(conversationId)
      if (!browser) return null
      browser.viewers.add(viewer)
      browser.lastActivity = Date.now()
      return browser
    }
    const initial = attach()
    send({ t: 'state', browser: initial ? this.toDto(initial) : null, watching: initial ? this.watchedTarget(initial) : null })
    if (initial) this.refreshCast(initial).catch(ignore)
    return {
      handle: async (message) => {
        const browser = this.running.get(conversationId) ?? null
        if (!browser) {
          send({ t: 'error', code: 'browser_closed', message: 'This conversation has no open browser.' })
          return
        }
        browser.viewers.add(viewer)
        browser.lastActivity = Date.now()
        await this.handle(browser, message).catch((err: unknown) => {
          send({ t: 'error', code: 'browser_command_failed', message: err instanceof Error ? err.message : String(err) })
        })
      },
      detach: () => {
        const browser = this.running.get(conversationId)
        if (!browser) return
        browser.viewers.delete(viewer)
        browser.lastActivity = Date.now()
        if (browser.viewers.size === 0) this.stopCast(browser).catch(ignore)
        this.broadcastState(browser)
      },
    }
  }

  async close(conversationId: string): Promise<void> {
    const browser = this.running.get(conversationId)
    if (!browser) return
    this.running.delete(conversationId)
    browser.cdp.close()
    for (const viewer of browser.viewers) viewer.send({ t: 'state', browser: null, watching: null })
    // Wait for Chromium to exit before removing its profile: it writes there until the end.
    await stopProcess(browser.process)
    await rm(browser.profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
  }

  async shutdown(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper)
    if (this.titles) clearInterval(this.titles)
    await Promise.all([...this.running.keys()].map((id) => this.close(id)))
  }

  private sweep(): void {
    const now = Date.now()
    for (const browser of this.running.values()) {
      if (browser.agents === 0 && browser.viewers.size === 0 && now - browser.lastActivity > IDLE_MS) this.close(browser.conversationId).catch(ignore)
    }
  }

  private ensure(conversationId: string): Promise<RunningBrowser> {
    const running = this.running.get(conversationId)
    if (running) return Promise.resolve(running)
    const pending = this.launching.get(conversationId)
    if (pending) return pending
    const launch = this.launch(conversationId).finally(() => this.launching.delete(conversationId))
    this.launching.set(conversationId, launch)
    return launch
  }

  private async launch(conversationId: string): Promise<RunningBrowser> {
    if (this.running.size >= MAX_BROWSERS) {
      throw new Error(`Too many agent browsers are open (${MAX_BROWSERS}). Close one from Services before opening another.`)
    }
    const engine = this.install.engine()
    if (!engine) throw new Error('No browser engine is installed. An administrator can install one under Settings › Agent tools.')
    const conversation = this.db.select({ projectId: conversations.projectId }).from(conversations).where(eq(conversations.id, conversationId)).get()
    if (!conversation) throw new Error('Unknown conversation.')

    const profile = join(this.root, 'profiles', conversationId)
    await rm(profile, { recursive: true, force: true })
    await mkdir(profile, { recursive: true })
    const args = [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter,OptimizationHints',
      '--window-size=1280,800',
      '--password-store=basic',
      '--use-mock-keychain',
      'about:blank',
    ]
    const env = { ...process.env, ...processOrigins(this.config.paths.data).environment(conversation.projectId, conversationId) }
    // Outside Sillage's cgroup on Linux, like other heavy jobs: Chromium's memory must not count
    // against the daemon's limit and throttle every session. `--scope` execs the command, so the
    // child is Chromium itself.
    const systemdRun = process.platform === 'linux' && process.env.XDG_RUNTIME_DIR ? resolveBinary('systemd-run') : null
    const child = systemdRun
      ? spawn(systemdRun, ['--user', '--scope', '--quiet', '--collect', `--unit=sillage-browser-${conversationId.slice(0, 8)}-${randomBytes(3).toString('hex')}`, '--', engine.path, ...args], { env, stdio: 'ignore' })
      : spawn(engine.path, args, { env, stdio: 'ignore', windowsHide: true })
    let exited = false
    child.once('exit', () => { exited = true })
    child.once('error', () => { exited = true })

    let endpoint: string | null = null
    const portFile = join(profile, 'DevToolsActivePort')
    for (const started = Date.now(); Date.now() - started < LAUNCH_TIMEOUT_MS && !exited; await delay(100)) {
      const content = await readFile(portFile, 'utf8').catch(() => '')
      const [port, path] = content.trim().split('\n')
      if (port && path) {
        endpoint = `ws://127.0.0.1:${port}${path}`
        break
      }
    }
    if (!endpoint) {
      child.kill()
      await rm(profile, { recursive: true, force: true }).catch(() => {})
      throw new Error(exited ? `The browser engine exited at launch (${engine.path}).` : 'The browser did not start in time.')
    }

    const cdp = await CdpConnection.open(endpoint)
    const browser: RunningBrowser = {
      conversationId,
      process: child,
      profile,
      endpoint,
      cdp,
      startedAt: Date.now(),
      tabs: new Map(),
      activeTargetId: null,
      agents: 0,
      viewers: new Set(),
      pinnedTargetId: null,
      cast: null,
      lastActivity: Date.now(),
    }
    cdp.on('event', (method: string, params: Record<string, unknown>, sessionId: string | null) => this.onEvent(browser, method, params, sessionId))
    cdp.on('close', () => { if (this.running.get(conversationId) === browser) this.close(conversationId).catch(ignore) })
    child.once('exit', () => { if (this.running.get(conversationId) === browser) this.close(conversationId).catch(ignore) })
    this.running.set(conversationId, browser)
    await cdp.send('Target.setDiscoverTargets', { discover: true })
    return browser
  }

  private onEvent(browser: RunningBrowser, method: string, params: Record<string, unknown>, sessionId: string | null): void {
    if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') {
      const info = params.targetInfo as { targetId: string; type: string; url: string; title: string }
      if (info.type !== 'page') return
      const known = browser.tabs.get(info.targetId)
      browser.tabs.set(info.targetId, { targetId: info.targetId, url: info.url, title: info.title })
      // A new tab or a navigation is the agent at work: follow it.
      if (!known || known.url !== info.url) browser.activeTargetId = info.targetId
      browser.lastActivity = Date.now()
      this.refreshCast(browser).catch(ignore)
      this.broadcastState(browser)
      return
    }
    if (method === 'Target.targetDestroyed') {
      const targetId = params.targetId as string
      if (!browser.tabs.delete(targetId)) return
      if (browser.activeTargetId === targetId) browser.activeTargetId = [...browser.tabs.keys()].at(-1) ?? null
      if (browser.pinnedTargetId === targetId) browser.pinnedTargetId = null
      if (browser.cast?.targetId === targetId) browser.cast = null
      this.refreshCast(browser).catch(ignore)
      this.broadcastState(browser)
      return
    }
    if (method === 'Page.screencastFrame' && sessionId && browser.cast?.sessionId === sessionId) {
      const frame = params as { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }
      browser.cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }, sessionId).catch(ignore)
      for (const viewer of browser.viewers) viewer.send({ t: 'frame', data: frame.data, width: frame.metadata.deviceWidth, height: frame.metadata.deviceHeight })
    }
  }

  private watchedTarget(browser: RunningBrowser): string | null {
    if (browser.pinnedTargetId && browser.tabs.has(browser.pinnedTargetId)) return browser.pinnedTargetId
    return browser.activeTargetId ?? [...browser.tabs.keys()].at(-1) ?? null
  }

  /** Screencasts the watched tab while someone watches; switches when the agent moves on. */
  private async refreshCast(browser: RunningBrowser): Promise<void> {
    if (browser.viewers.size === 0) return
    const target = this.watchedTarget(browser)
    if (browser.cast?.targetId === target) return
    await this.stopCast(browser)
    if (!target) return
    const { sessionId } = await browser.cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId: target, flatten: true })
    browser.cast = { targetId: target, sessionId }
    await browser.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1600, maxHeight: 1200 }, sessionId)
    // A still page sends no frame until it repaints: show its current state at once.
    const shot = await browser.cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality: 70 }, sessionId)
    const metrics = await browser.cdp.send<{ cssLayoutViewport: { clientWidth: number; clientHeight: number } }>('Page.getLayoutMetrics', {}, sessionId)
    for (const viewer of browser.viewers) {
      viewer.send({ t: 'frame', data: shot.data, width: metrics.cssLayoutViewport.clientWidth, height: metrics.cssLayoutViewport.clientHeight })
    }
    this.broadcastState(browser)
  }

  private async stopCast(browser: RunningBrowser): Promise<void> {
    const cast = browser.cast
    if (!cast) return
    browser.cast = null
    await browser.cdp.send('Page.stopScreencast', {}, cast.sessionId).catch(() => {})
    await browser.cdp.send('Target.detachFromTarget', { sessionId: cast.sessionId }).catch(() => {})
  }

  private async handle(browser: RunningBrowser, message: BrowserClientMessage): Promise<void> {
    if (message.t === 'watch') {
      browser.pinnedTargetId = message.targetId
      await this.refreshCast(browser)
      this.broadcastState(browser)
      return
    }
    await this.refreshCast(browser)
    const session = browser.cast?.sessionId
    if (!session) throw new Error('No tab to act on.')
    const send = (method: string, params: Record<string, unknown> = {}) => browser.cdp.send(method, params, session)
    switch (message.t) {
      case 'mouse':
        await send('Input.dispatchMouseEvent', { type: message.type, x: message.x, y: message.y, button: message.button, clickCount: message.clickCount, modifiers: message.modifiers })
        return
      case 'wheel':
        await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: message.x, y: message.y, deltaX: message.deltaX, deltaY: message.deltaY, modifiers: message.modifiers })
        return
      case 'key':
        await send('Input.dispatchKeyEvent', {
          type: message.type === 'keyDown' && message.text ? 'keyDown' : message.type === 'keyDown' ? 'rawKeyDown' : 'keyUp',
          key: message.key,
          code: message.code,
          ...(message.text ? { text: message.text, unmodifiedText: message.text } : {}),
          ...(message.keyCode !== undefined ? { windowsVirtualKeyCode: message.keyCode, nativeVirtualKeyCode: message.keyCode } : {}),
          modifiers: message.modifiers,
        })
        return
      case 'text':
        await send('Input.insertText', { text: message.text })
        return
      case 'navigate': {
        const url = /^[a-z][a-z0-9+.-]*:/i.test(message.url) ? message.url : `https://${message.url}`
        await send('Page.navigate', { url })
        return
      }
      case 'history': {
        if (message.action === 'reload') {
          await send('Page.reload')
          return
        }
        const history = await send('Page.getNavigationHistory') as { currentIndex: number; entries: { id: number }[] }
        const entry = history.entries[history.currentIndex + (message.action === 'back' ? -1 : 1)]
        if (entry) await send('Page.navigateToHistoryEntry', { entryId: entry.id })
        return
      }
    }
  }

  private broadcastState(browser: RunningBrowser): void {
    if (browser.viewers.size === 0) return
    const dto = this.toDto(browser)
    const watching = this.watchedTarget(browser)
    for (const viewer of browser.viewers) viewer.send({ t: 'state', browser: dto, watching })
  }

  private toDto(browser: RunningBrowser): BrowserDto {
    const row = this.db
      .select({ title: conversations.title, projectId: conversations.projectId })
      .from(conversations)
      .where(eq(conversations.id, browser.conversationId))
      .get()
    return {
      conversationId: browser.conversationId,
      conversationTitle: row?.title ?? '',
      projectId: row?.projectId ?? null,
      startedAt: browser.startedAt,
      activeTargetId: browser.activeTargetId,
      tabs: [...browser.tabs.values()],
      agentConnected: browser.agents > 0,
      viewers: browser.viewers.size,
    }
  }
}

/**
 * Detached browser work (screencast switches, idle closes) must never reject unhandled: that would
 * stop the daemon. A failed switch only leaves the view on its previous frame.
 */
function ignore(): void {}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.kill()
  const settled = await Promise.race([exited.then(() => true), delay(5000).then(() => false)])
  if (!settled) {
    child.kill('SIGKILL')
    await Promise.race([exited, delay(2000)])
  }
}

/** Created once with owner-only permissions; losing it only invalidates running MCP servers' URLs. */
function loadKey(path: string): Buffer {
  if (existsSync(path)) {
    const key = Buffer.from(readFileSync(path, 'utf8').trim(), 'hex')
    if (key.length === 32) return key
  }
  const key = randomBytes(32)
  try {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, key.toString('hex'), { mode: 0o600 })
  } catch {
    // Read-only data directory: keep the key in memory for this process.
  }
  return key
}
