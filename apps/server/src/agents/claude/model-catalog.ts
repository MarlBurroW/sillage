import { homedir } from 'node:os'
import type {
  AccountInfo,
  AgentInfo,
  FastModeDisabledReason,
  FastModeState,
  ModelInfo,
} from '@anthropic-ai/claude-agent-sdk'
import { CachedProbe } from '../cached-probe.js'
import { withControlSession } from './control-session.js'

/**
 * Claude catalog: models, account, output styles, subagents, Fast availability read from installed
 * CLI, not hardcoded.
 *
 * `supportedModels()`/`accountInfo()` are control requests (`withControlSession`): no model
 * messages, tokens, quota. Other data comes from already-received initialization. Process costs
 * ~400 MB during probe, hence caching and one combined read.
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
  private readonly cached = new CachedProbe(CACHE_TTL_MS, () => this.probe())

  /**
   * Resolve binary per probe, never at construction: honors Sillage-installed CLI prefix and
   * agents.claude.binary, including installation while daemon runs.
   */
  constructor(private readonly executable: () => Promise<string>) {}

  list(): Promise<Listing & { fetchedAt: number }> {
    return this.cached.read()
  }

  private probe(): Promise<Listing> {
    return withControlSession(
      { executable: this.executable, cwd: homedir(), tag: 'catalog' },
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
