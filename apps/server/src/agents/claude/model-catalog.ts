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
 *
 * The same CLI under the same login answers with one of two lists (probed 2.1.318): the catalog
 * Anthropic serves, or a shorter compiled one when the server-side flag `tengu_delegated_quail` is
 * off for that process, or when the download misses the CLI's 1.5 s headless wait. The flag flips
 * several times a day and the SDK does not say which list it returned, so a scheduled probe that
 * comes back reduced does not replace the fuller list already seen: the model selector would lose
 * most of its rows until someone pressed refresh.
 */

const CACHE_TTL_MS = 60 * 60 * 1000

export interface Listing {
  models: ModelInfo[]
  account: AccountInfo | null
  /** CLI that answered: a fuller list from another version proves nothing about this one. */
  cliVersion: string | null
  /** Native CLI names, including `default`. */
  outputStyles: string[]
  agents: AgentInfo[]
  /**
   * Account Fast state before session requests it. `state` stays null on unaware CLIs, distinct
   * from off.
   */
  fastMode: { state: FastModeState | null; reason: FastModeDisabledReason | null }
}

/** Canonical model behind a row: aliases and versioned names of one model must compare equal. */
const modelId = (model: ModelInfo): string => model.resolvedModel ?? model.value

/**
 * Whether `next` is the compiled short list of the catalog `kept` came from: same CLI and same
 * login, fewer rows, and no model `kept` does not already offer. A plan change or a CLI update
 * fails the identity checks; a new model fails the last one.
 */
export function isReducedCatalog(
  next: Pick<Listing, 'models' | 'account' | 'cliVersion'>,
  kept: Pick<Listing, 'models' | 'account' | 'cliVersion'>,
): boolean {
  if (next.cliVersion !== kept.cliVersion) return false
  if (next.account?.email !== kept.account?.email) return false
  if (next.account?.organization !== kept.account?.organization) return false
  if (next.account?.subscriptionType !== kept.account?.subscriptionType) return false
  if (next.models.length >= kept.models.length) return false
  const offered = new Set(kept.models.map(modelId))
  return next.models.every((model) => offered.has(modelId(model)))
}

export class ClaudeModelCatalog {
  /** Fullest models each credential answered with since the last explicit refresh. */
  private readonly fullest = new Map<string, Pick<Listing, 'models' | 'account' | 'cliVersion'>>()
  private readonly cached: CachedProbeMap<Listing>

  /**
   * Resolve binary per probe, never at construction: honors Sillage-installed CLI prefix and
   * agents.claude.binary, including installation while daemon runs.
   */
  constructor(
    private readonly executable: () => Promise<string>,
    /** Replaced in tests, which cannot start a CLI. */
    probe: (credential?: string) => Promise<Listing> = (credential) => this.probe(credential),
  ) {
    this.cached = new CachedProbeMap<Listing>(CACHE_TTL_MS, (credential) => probe(credential || undefined))
  }

  invalidate(): void {
    this.cached.invalidate()
    this.fullest.clear()
  }

  /**
   * `force` is the user's refresh: it takes whatever the CLI answers, so a model Anthropic really
   * withdrew does not linger past a click.
   */
  async list(credential?: string, force = false): Promise<Listing & { fetchedAt: number }> {
    const key = credential ?? ''
    const listing = await this.cached.read(key, force)
    const kept = this.fullest.get(key)
    if (!force && kept && isReducedCatalog(listing, kept)) return { ...listing, models: kept.models }
    this.fullest.set(key, { models: listing.models, account: listing.account, cliVersion: listing.cliVersion })
    return listing
  }

  /**
   * Model behind the `default` row of the list this credential's selector shows, null before any
   * read. Never probes: sessions ask at launch, where a CLI start would delay the first message.
   */
  defaultModel(credential?: string): string | null {
    const row = this.fullest.get(credential ?? '')?.models.find((model) => model.value === 'default')
    return row?.resolvedModel ?? null
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
          cliVersion: init?.claude_code_version ?? null,
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
