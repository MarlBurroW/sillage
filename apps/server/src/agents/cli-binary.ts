import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import nodePath from 'node:path'
import { promisify } from 'node:util'
import type { AgentAvailabilityDto, AgentKind } from '@sillage/protocol'
import { CachedProbe } from './cached-probe.js'
import { launchOf } from './launch.js'

const run = promisify(execFile)

/** Installed agent CLI resolution and probing. System binaries are not release-guaranteed, so expose presence/version and show missing CLIs before first-turn failures. Search Sillage-managed npm prefixes then `process.env.PATH`, never hardcoded directories: systemd already supplies explicit minimal-service PATH and `spawn` uses the same. Other resolution would advertise CLIs the daemon cannot launch. */

/** `describe` availability data excluding installation state, which belongs to `CliInstaller` rather than binaries. */
export type CliDescription = Omit<AgentAvailabilityDto, 'preferredVersion' | 'install'>

/** Known CLI information after disk resolution. */
export type CliStatus =
  | { readonly found: true; readonly path: string; readonly version: string | null }
  | { readonly found: false; readonly reason: 'not_on_path' | 'not_executable' }

/** Probe cache lifetime: installations made while daemons run must eventually appear without spawning processes for every screen. */
const TTL_MS = 60_000

/** Time allowed for version announcements. Afterward report present but silent: slow binaries remain usable. Longer on Windows because Defender scans newly installed binaries; Grok exceeded five seconds immediately after installation. */
const VERSION_TIMEOUT_MS = process.platform === 'win32' ? 20_000 : 5_000

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/** Absolute binary path or null. Search bare names through PATH like `spawn`; absolute paths select specific installations and must not be replaced. Windows adds `PATHEXT` extensions (`claude.exe`, `codex.cmd`), while npm places launchers at prefix roots rather than `bin/`. `env` and `platform` support tests only. */
export function resolveBinary(
  binary: string,
  managedDir?: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = isExecutable,
): string | null {
  const windows = platform === 'win32'
  const paths = windows ? nodePath.win32 : nodePath.posix
  const names = windows ? withExtensions(binary, env) : [binary]
  if (paths.isAbsolute(binary)) return names.find(exists) ?? null

  // Names containing separators are relative paths `spawn` would resolve from daemon
  // cwd, unrelated to conversation workspaces,
  // making these settings meaningless: reject them.
  if (binary.includes('/') || (windows && binary.includes('\\'))) return null

  // Managed installations precede system PATH, reflecting intent: users requested
  // them explicitly through interfaces, while PATH CLIs may be accidental.
  // This is also the only way to honor
  // 'Sillage uses this specific version' when systems
  // already have another installed.
  const dirs = managedDir ? [windows ? managedDir : paths.join(managedDir, 'bin')] : []
  dirs.push(...(pathValue(env) ?? '').split(paths.delimiter).filter((dir) => dir.length > 0))
  for (const dir of dirs) {
    const found = names.map((name) => paths.join(dir, name)).find(exists)
    if (found) return found
  }
  return null
}

/** Windows candidate names for `binary` in `PATHEXT` order. Names already carrying known extensions are searched unchanged. */
function withExtensions(binary: string, env: NodeJS.ProcessEnv): string[] {
  const extensions = (pathExt(env) ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  if (extensions.some((ext) => binary.toLowerCase().endsWith(ext.toLowerCase()))) return [binary]
  return extensions.map((ext) => `${binary}${ext.toLowerCase()}`)
}

/** Case-insensitive PATH key lookup: Windows uses `Path`, and copying `process.env` into ordinary objects loses case insensitivity. */
function pathValue(env: NodeJS.ProcessEnv): string | undefined {
  return env.PATH ?? Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1]
}

function pathExt(env: NodeJS.ProcessEnv): string | undefined {
  return env.PATHEXT ?? Object.entries(env).find(([key]) => key.toUpperCase() === 'PATHEXT')?.[1]
}

/** Version number from `--version`. CLI wrappers differ ('2.1.0 (Claude Code)', 'codex-cli 0.5.1'); retain the first version-like group, otherwise the line. Null for unusable responses: present without version is better than missing. */
async function probeVersion(binary: string): Promise<string | null> {
  try {
    const launch = launchOf(binary)
    const { stdout } = await run(launch.command, [...launch.args, '--version'], {
      timeout: VERSION_TIMEOUT_MS,
      windowsHide: true,
    })
    const line = stdout.trim().split('\n')[0]?.trim()
    if (!line) return null
    return /\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/.exec(line)?.[0] ?? line
  } catch {
    return null
  }
}

async function probe(binary: string, managedDir: string): Promise<CliStatus> {
  const path = resolveBinary(binary, managedDir)
  if (!path) {
    // Distinguish missing files from nonexecutable binaries:
    // one needs installation, the other `chmod`.
    return { found: false, reason: nodePath.isAbsolute(binary) ? 'not_executable' : 'not_on_path' }
  }
  return { found: true, path, version: await probeVersion(path) }
}

/** Agent CLI location, version and usability. One instance per adapter because caches and shared in-flight probes belong to CLIs, not callers. Includes API formatting otherwise duplicated across adapters. */
export class CliBinary {
  private readonly cache: CachedProbe<{ status: CliStatus }>

  constructor(
    private readonly kind: AgentKind,
    readonly configured: string,
    private readonly enabled: boolean,
    /** Managed CLI npm prefix. */
    readonly managedDir: string,
  ) {
    this.cache = new CachedProbe(TTL_MS, async () => ({
      status: await probe(configured, managedDir),
    }))
  }

  async status(force = false): Promise<CliStatus> {
    return (await this.cache.read(force)).status
  }

  /** Invalidates probes after known disk changes. Successful installations must not remain absent until TTL expiry or interfaces would offer installation again. */
  invalidate(): void {
    this.cache.invalidate()
  }

  /** Screen-visible state. Do not probe configuration-disabled agents: launching explicitly excluded CLIs wastes work, and 'missing' misstates why they are unavailable. */
  async describe(force = false): Promise<CliDescription> {
    const base = { agent: this.kind, binary: this.configured, enabled: this.enabled }
    if (!this.enabled) {
      return {
        ...base,
        installed: false,
        managed: false,
        path: null,
        version: null,
        reason: 'disabled',
      }
    }

    const status = await this.status(force)
    if (!status.found) {
      return {
        ...base,
        installed: false,
        managed: false,
        path: null,
        version: null,
        reason: status.reason,
      }
    }
    return {
      ...base,
      installed: true,
      // Binary provenance lets users distinguish system CLIs
      // from Sillage-managed installations.
      managed: status.path.startsWith(this.managedDir),
      path: status.path,
      version: status.version,
      reason: null,
    }
  }

  /** Absolute executable path or configured name when resolution fails. Let `spawn` produce its precise `ENOENT` rather than invent errors, and avoid blocking launches that may succeed despite failed cold resolution. */
  async executable(): Promise<string> {
    const status = await this.status()
    return status.found ? status.path : this.configured
  }
}
