import { homedir } from 'node:os'
import type { Query } from '@anthropic-ai/claude-agent-sdk'
import type { ClaudeSandboxSupportDto } from '@sillage/protocol'
import { CachedProbe } from '../cached-probe.js'
import { agentProcessEnv } from '../process-env.js'
import { withControlSession } from './control-session.js'

/** Packages are rarely installed mid-session; the settings menu can force a new check. */
const CACHE_MS = 10 * 60_000

type Support = Omit<ClaudeSandboxSupportDto, 'checkedAt'>

/**
 * The CLI's refusal, without its own advice: `failIfUnavailable: false` is the unconfined
 * execution Sillage never asks for. Shape on 2.1.332: "Sandbox required but unavailable: sandbox
 * is enabled but dependencies are missing: socat not installed · install missing tools (e.g. apt
 * install bubblewrap socat) or see https://…. Set sandbox.failIfUnavailable=false to allow
 * unsandboxed execution."
 */
export function sandboxFailureReason(errors: readonly string[]): string | null {
  const text = errors.join(' ')
    .replace(/^\s*Sandbox required but unavailable:\s*/i, '')
    .replace(/\s*Set sandbox\.failIfUnavailable\s*=\s*false[^]*$/i, '')
    .trim()
  return text || null
}

/**
 * Asks the CLI to start with a required sandbox, sending no prompt: refused, it answers with a
 * `result` naming `sandbox_required_unavailable` before any model request; accepted, its
 * initialization reports `sandbox_enabled`. Probed on 2.1.332, about 200 ms either way.
 */
export async function readSandboxSupport(session: Query): Promise<Support> {
  let refusal: { reason: string | undefined; errors: string[] } | null = null
  const watching = (async () => {
    for await (const message of session) {
      if (message.type === 'result' && message.subtype !== 'success') {
        const fields = message as { startup_failure_reason?: string; errors?: unknown }
        refusal = {
          reason: fields.startup_failure_reason,
          errors: Array.isArray(fields.errors) ? fields.errors.filter((error): error is string => typeof error === 'string') : [],
        }
        return
      }
    }
  })().catch(() => {})
  try {
    const init = await session.initializationResult()
    // Not in the SDK's types, sent by the CLI since at least 2.1.332.
    const enabled = (init as { sandbox_enabled?: unknown }).sandbox_enabled
    if (enabled === true) return { state: 'available', reason: null }
    return { state: enabled === false ? 'unavailable' : 'unknown', reason: null }
  } catch (err) {
    await watching
    const seen = refusal as { reason: string | undefined; errors: string[] } | null
    if (seen?.reason === 'sandbox_required_unavailable') return { state: 'unavailable', reason: sandboxFailureReason(seen.errors) }
    const detail = seen?.errors.join(' ') || (err instanceof Error ? err.message : String(err))
    return { state: 'unknown', reason: detail.slice(0, 500) || null }
  }
}

/** One probe per cache window, shared by every composer asking. */
export class ClaudeSandboxSupport {
  private readonly cache: CachedProbe<Support>

  constructor(
    executable: () => Promise<string>,
    probe: (executable: () => Promise<string>) => Promise<Support> = (resolve) => withControlSession(
      {
        executable: resolve,
        cwd: homedir(),
        tag: 'sandbox',
        // The sessions' own PATH: the CLI looks for bubblewrap and socat on it.
        options: { env: agentProcessEnv(), sandbox: { enabled: true, failIfUnavailable: true } },
      },
      readSandboxSupport,
    ),
  ) {
    this.cache = new CachedProbe(CACHE_MS, async () => {
      try {
        return await probe(executable)
      } catch (err) {
        return { state: 'unknown', reason: err instanceof Error ? err.message.slice(0, 500) : null }
      }
    })
  }

  async read(force = false): Promise<ClaudeSandboxSupportDto> {
    const { fetchedAt, ...support } = await this.cache.read(force)
    return { ...support, checkedAt: fetchedAt }
  }
}
