import { execFile } from 'node:child_process'
import { launchOf } from '../launch.js'
import { statSync } from 'node:fs'
import { promisify } from 'node:util'
import { HttpError } from '../../http/errors.js'

const run = promisify(execFile)

/**
 * Last opencode major supported by adapter.
 *
 * Adapter uses first opencode serve API (/session/..., GET /event). OpenCode 2 removed it for
 * /api/...: 2.x starts but requests miss, leaving silent conversation. Reject before launch with
 * readable reason.
 */
export const SUPPORTED_OPENCODE_MAJOR = 1

const VERSION_TIMEOUT_MS = 5_000

/**
 * opencode too new for adapter. HttpError propagates unchanged to message sending; UI translates
 * code.
 */
export class OpencodeUnsupportedVersionError extends HttpError {
  constructor(readonly version: string) {
    // Version written literally, not {version}: logs/forks/probes use message unchanged without
    // interpolation.
    super(
      409,
      'opencode_unsupported_version',
      `OpenCode ${version} is not supported: Sillage speaks the OpenCode 1.x server API, which OpenCode 2 removed. Install OpenCode 1.x (opencode-ai) and do not run \`opencode upgrade --major\`.`,
      { version },
    )
    this.name = 'OpencodeUnsupportedVersionError'
  }
}

/**
 * Binary-keyed probed version including mtime/size: in-place upgrades would bypass path-only cache.
 * Probe only changed binaries, costing --version on first launch.
 */
const versions = new Map<string, { key: string; version: Promise<string | null> }>()

function fileKey(binary: string): string {
  try {
    const stats = statSync(binary)
    return `${stats.mtimeMs}:${stats.size}`
  } catch {
    // Bare name/unreadable file: spawn reports failure itself.
    return 'unknown'
  }
}

async function readVersion(binary: string): Promise<string | null> {
  try {
    const launch = launchOf(binary)
    const { stdout } = await run(launch.command, [...launch.args, '--version'], { timeout: VERSION_TIMEOUT_MS, windowsHide: true })
    // 1.x returns “1.19.3”, 2.x “opencode v2.0.32”: retain number only.
    return /\d+\.\d+(?:\.\d+)?(?:[-+][\w.]+)?/.exec(stdout)?.[0] ?? null
  } catch {
    return null
  }
}

export function opencodeVersion(binary: string): Promise<string | null> {
  const key = fileKey(binary)
  const cached = versions.get(binary)
  if (cached && cached.key === key) return cached.version
  const version = readVersion(binary)
  versions.set(binary, { key, version })
  return version
}

/**
 * Reject unsupported opencode majors.
 *
 * Unreadable versions pass: possible launch failure beats invented rejection for malformed
 * --version output.
 */
export async function assertSupportedOpencode(binary: string): Promise<void> {
  const version = await opencodeVersion(binary)
  const major = version ? Number(version.split('.')[0]) : NaN
  if (major > SUPPORTED_OPENCODE_MAJOR) throw new OpencodeUnsupportedVersionError(version!)
}
