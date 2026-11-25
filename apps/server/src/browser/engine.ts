import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { PLAYWRIGHT_MCP_PACKAGE, PLAYWRIGHT_MCP_VERSION, type BrowserEngineSource, type BrowserStatusDto } from '@sillage/protocol'
import { resolveBinary } from '../agents/cli-binary.js'
import { launchOf } from '../agents/launch.js'

/**
 * Finds the pieces the browser family needs, and installs the missing ones on an admin's request.
 * Nothing ships in Sillage's releases: the MCP server is a 100 KB npm package, and the engine is
 * preferably one already on the machine (Chrome on a desktop, Playwright's cache on a dev server).
 */

/** Playwright's own cache layout, shared by every project on the machine. */
function playwrightCacheDirs(): string[] {
  const dirs = [process.env.PLAYWRIGHT_BROWSERS_PATH].filter((dir): dir is string => Boolean(dir) && dir !== '0')
  if (process.platform === 'darwin') dirs.push(join(homedir(), 'Library/Caches/ms-playwright'))
  else if (process.platform === 'win32') dirs.push(join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData/Local'), 'ms-playwright'))
  else dirs.push(join(homedir(), '.cache/ms-playwright'))
  return dirs
}

/**
 * Full Chromium from a Playwright cache, newest Chromium first. The full build rather than
 * `chromium_headless_shell`: it is the one marldev's AppArmor profile and most setups cover, and
 * renders like the Chrome people use. Ordered by the engine's own version: neither the revision
 * number (Playwright once numbered snapshots, `chromium-815036` is Chromium 88) nor the install
 * date (an old project can install an old revision today) says which is newest.
 */
function chromiumInCache(dir: string): string | null {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return null
  }
  const tails = process.platform === 'win32'
    ? ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe']
    : process.platform === 'darwin'
      ? ['chrome-mac-arm64/Chromium.app/Contents/MacOS/Chromium', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
          'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
          'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing']
      : ['chrome-linux64/chrome', 'chrome-linux/chrome']
  const found = entries
    .filter((name) => /^chromium-\d+$/.test(name) && existsSync(join(dir, name, 'INSTALLATION_COMPLETE')))
    .map((name) => tails.map((tail) => join(dir, name, tail)).find((path) => existsSync(path)))
    .filter((path): path is string => path !== undefined)
    .map((path) => ({ path, version: engineVersion(path) }))
    .sort((a, b) => compareVersions(b.version, a.version))
  return found[0]?.path ?? null
}

const versions = new Map<string, number[]>()

/** `Chromium 151.0.7922.34` → [151, 0, 7922, 34]; empty when the binary will not say (Windows). */
function engineVersion(path: string): number[] {
  const cached = versions.get(path)
  if (cached) return cached
  let parsed: number[] = []
  if (process.platform !== 'win32') {
    try {
      const output = execFileSync(path, ['--version'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] })
      parsed = (/(\d+)\.(\d+)\.(\d+)\.(\d+)/.exec(output) ?? []).slice(1).map(Number)
    } catch {
      parsed = []
    }
  }
  versions.set(path, parsed)
  return parsed
}

function compareVersions(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? -1) - (b[i] ?? -1)
    if (diff !== 0) return diff
  }
  return 0
}

/** Chrome, Chromium or Edge installed for people: what a Desktop user almost always has. */
function systemBrowser(): string | null {
  if (process.platform === 'darwin') {
    return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'].find((path) => existsSync(path)) ?? null
  }
  if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter((root): root is string => Boolean(root))
    for (const root of roots) {
      for (const tail of ['Google/Chrome/Application/chrome.exe', 'Microsoft/Edge/Application/msedge.exe', 'Chromium/Application/chrome.exe']) {
        const path = join(root, tail)
        if (existsSync(path)) return path
      }
    }
    return null
  }
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge']) {
    const path = resolveBinary(name)
    // Ubuntu's `chromium-browser` can be a snap shim; it still runs headless, so accept it.
    if (path) return path
  }
  return null
}

export interface BrowserEngine {
  path: string
  source: BrowserEngineSource
}

export class BrowserInstall {
  private installing: Promise<void> | null = null
  private progress: string | null = null
  private error: string | null = null

  constructor(private readonly root: string) {}

  /** npm prefix holding `@playwright/mcp` and its Playwright copy. */
  get mcpPrefix(): string {
    return join(this.root, 'mcp')
  }

  /** Engines Sillage downloaded itself, in Playwright's cache layout. */
  get enginesDir(): string {
    return join(this.root, 'engines')
  }

  /** Path to the MCP entry point, run with the daemon's Node rather than through npx. */
  mcpEntry(): string | null {
    const entry = join(this.mcpPrefix, 'node_modules', PLAYWRIGHT_MCP_PACKAGE, 'cli.js')
    return existsSync(entry) ? entry : null
  }

  mcpVersion(): string | null {
    try {
      const manifest = JSON.parse(readFileSync(join(this.mcpPrefix, 'node_modules', PLAYWRIGHT_MCP_PACKAGE, 'package.json'), 'utf8')) as { version?: string }
      return manifest.version ?? null
    } catch {
      return null
    }
  }

  /** Re-resolved on each call: an engine installed or removed meanwhile is picked up without restart. */
  engine(): BrowserEngine | null {
    const configured = process.env.SILLAGE_BROWSER_EXECUTABLE
    if (configured && existsSync(configured)) return { path: configured, source: 'config' }
    const own = chromiumInCache(this.enginesDir)
    if (own) return { path: own, source: 'sillage' }
    for (const dir of playwrightCacheDirs()) {
      const cached = chromiumInCache(dir)
      if (cached) return { path: cached, source: 'playwright-cache' }
    }
    const system = systemBrowser()
    return system ? { path: system, source: 'system' } : null
  }

  status(): BrowserStatusDto {
    const version = this.mcpVersion()
    const engine = this.engine()
    const mcp = { installed: version === PLAYWRIGHT_MCP_VERSION && this.mcpEntry() !== null, version }
    return {
      mcp,
      engine,
      ready: mcp.installed && engine !== null,
      installing: this.installing !== null,
      progress: this.installing ? this.progress : null,
      error: this.error,
    }
  }

  /**
   * Installs the pinned MCP server, and a Chromium only when the machine has no usable browser.
   * Runs in the background: the status reports progress, and a second request joins the first.
   */
  install(): Promise<void> {
    if (this.installing) return this.installing
    this.error = null
    this.installing = (async () => {
      try {
        await mkdir(this.mcpPrefix, { recursive: true })
        if (this.mcpVersion() !== PLAYWRIGHT_MCP_VERSION) {
          this.progress = `npm install ${PLAYWRIGHT_MCP_PACKAGE}@${PLAYWRIGHT_MCP_VERSION}`
          await this.run(resolveBinary('npm'), ['install', '--prefix', this.mcpPrefix, '--no-fund', '--no-audit', '--no-progress', '--omit=dev', `${PLAYWRIGHT_MCP_PACKAGE}@${PLAYWRIGHT_MCP_VERSION}`], {})
        }
        if (!this.engine()) {
          // Playwright's CLI from the MCP's own dependency fetches the Chromium revision it expects.
          const cli = join(this.mcpPrefix, 'node_modules', 'playwright', 'cli.js')
          this.progress = 'playwright install chromium'
          await this.run(process.execPath, [cli, 'install', 'chromium'], { PLAYWRIGHT_BROWSERS_PATH: this.enginesDir })
        }
      } catch (err) {
        this.error = err instanceof Error ? err.message : String(err)
        throw err
      } finally {
        this.installing = null
        this.progress = null
      }
    })()
    // Callers that do not await (the route answers at once) must not leave an unhandled rejection.
    this.installing.catch(() => {})
    return this.installing
  }

  private run(binary: string | null, args: string[], env: Record<string, string>): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!binary) {
        reject(new Error('npm is not available on the server: the browser tools cannot be installed.'))
        return
      }
      const launch = launchOf(binary)
      const child = spawn(launch.command, [...launch.args, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      let tail = ''
      const keep = (chunk: Buffer) => { tail = (tail + chunk.toString()).slice(-4000) }
      child.stdout.on('data', keep)
      child.stderr.on('data', keep)
      child.on('error', reject)
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`${args.slice(0, 2).join(' ')} failed (code ${code ?? '?'}): ${tail.trim().split('\n').slice(-6).join('\n')}`))
      })
    })
  }
}
