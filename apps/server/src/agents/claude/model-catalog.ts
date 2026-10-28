import { homedir } from 'node:os'
import type {
  AccountInfo,
  AgentInfo,
  FastModeDisabledReason,
  FastModeState,
  ModelInfo,
} from '@anthropic-ai/claude-agent-sdk'
import { CachedProbeMap } from '../cached-probe.js'
import { withControlSession } from './control-session.js'
import { claudeAuthEnv } from './credential.js'

/**
 * Claude catalog: models, account, output styles, subagents, Fast availability read from installed
 * CLI, not hardcoded.
 *
 * `supportedModels()`/`accountInfo()` are control requests (`withControlSession`): no model
 * messages, tokens, quota. Other data comes from already-received initialization. Process costs
 * ~400 MB during probe, hence caching and one combined read.
 *
 * Models and subscription type follow the authentication: additional accounts probe under their
 * own token, one cache entry per credential (empty for the CLI's own login).
 */

const CACHE_TTL_MS = 60 * 60 * 1000

interface Listing {
  models: ModelInfo[]
  account: AccountInfo | null
  /** Native CLI names, including `default`. */
  outputStyles: string[]
  agents: AgentInfo[]
  /**
   * Account Fast state before session requests it. `state` stays null on unaware CLIs, distinct
   * from off.
   */
  fastMode: { state: FastModeState | null; reason: FastModeDisabledReason | null }
}

export class ClaudeModelCatalog {
  private readonly cached = new CachedProbeMap<Listing>(CACHE_TTL_MS, (credential) => this.probe(credential || undefined))

  /**
   * Resolve binary per probe, never at construction: honors Sillage-installed CLI prefix and
   * agents.claude.binary, including installation while daemon runs.
   */
  constructor(private readonly executable: () => Promise<string>) {}

  list(credential?: string, force = false): Promise<Listing & { fetchedAt: number }> {
    return this.cached.read(credential ?? '', force)
  }

  private probe(credential?: string): Promise<Listing> {
    const env = claudeAuthEnv(credential)
    return withControlSession(
      { executable: this.executable, cwd: homedir(), tag: 'catalog', ...(env ? { options: { env } } : {}) },
      async (session) => {
        const models = await session.supportedModels()
        // Account is secondary: absence must not remove model list.
        const account = await session.accountInfo().catch(() => null)
        // Same for others: unsupported CLI requests leave empty lists and hide corresponding
        // settings.
        const init = await session.initializationResult().catch(() => null)
        return {
          models,
          account,
          outputStyles: init?.available_output_styles ?? [],
          agents: init?.agents ?? [],
          fastMode: {
            state: init?.fast_mode_state ?? null,
            reason: init?.fast_mode_disabled_reason ?? null,
          },
        }
      },
    )
  }
}
