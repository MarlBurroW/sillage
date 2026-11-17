import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname } from 'node:path'
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
 * The same CLI under the same login answers with one of two lists (probed 2.1.318 and 2.1.325):
 * the catalog Anthropic serves, or a shorter compiled one when the flag `tengu_delegated_quail`
 * reads off at startup, or when the download misses the CLI's 1.5 s headless wait. The flag is
 * cached in `~/.claude.json`, which every Claude Code on the machine shares: an older CLI run by
 * another tool (2.1.257 here) writes "off" there and the next process starts on the compiled
 * list. The SDK does not say which list it returned, so an answer that is a reduced view of a
 * fuller list already seen does not replace it, on a refresh either: the refresh would land on
 * the same stale flag. The fuller list is kept on disk because a restart would otherwise forget it.
 */

const CACHE_TTL_MS = 60 * 60 * 1000

/**
 * How long a fuller list outlives its last confirmation by the CLI. Anthropic can withdraw a model
 * from the served catalog, which also looks like a reduced answer: it then lingers this long.
 */
const KEPT_TTL_MS = 7 * 24 * 60 * 60 * 1000

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

/** Fullest list a credential answered with, and when the CLI last answered with it. */
interface Kept extends Pick<Listing, 'models' | 'account' | 'cliVersion'> {
  confirmedAt: number
}

/** Credentials are tokens: the file on disk names them by digest only. */
const keptKey = (credential: string | undefined): string =>
  createHash('sha256').update(credential ?? '').digest('hex').slice(0, 16)

interface CatalogOptions {
  /** Replaced in tests, which cannot start a CLI. */
  probe?: (credential?: string) => Promise<Listing>
  /** File the kept lists survive restarts in; memory only when absent. */
  storePath?: string
  now?: () => number
}

export class ClaudeModelCatalog {
  private readonly fullest = new Map<string, Kept>()
  private readonly cached: CachedProbeMap<Listing>
  private readonly storePath: string | undefined
  private readonly now: () => number

  /**
   * Resolve binary per probe, never at construction: honors Sillage-installed CLI prefix and
   * agents.claude.binary, including installation while daemon runs.
   */
  constructor(
    private readonly executable: () => Promise<string>,
    options: CatalogOptions = {},
  ) {
    const probe = options.probe ?? ((credential) => this.probe(credential))
    this.cached = new CachedProbeMap<Listing>(CACHE_TTL_MS, (credential) => probe(credential || undefined))
    this.storePath = options.storePath
    this.now = options.now ?? Date.now
    this.load()
  }

  /** After a CLI installation: lists kept from the previous version prove nothing. */
  invalidate(): void {
    this.cached.invalidate()
    this.fullest.clear()
    this.save()
  }

  async list(credential?: string, force = false): Promise<Listing & { fetchedAt: number }> {
    const listing = await this.cached.read(credential ?? '', force)
    const key = keptKey(credential)
    const kept = this.fullest.get(key)
    if (kept && this.now() - kept.confirmedAt < KEPT_TTL_MS && isReducedCatalog(listing, kept)) {
      return { ...listing, models: kept.models }
    }
    // One write per probe: reads served from the probe cache change nothing.
    if (!kept || kept.confirmedAt !== listing.fetchedAt || kept.models !== listing.models) {
      const { models, account, cliVersion } = listing
      this.fullest.set(key, { models, account, cliVersion, confirmedAt: listing.fetchedAt })
      this.save()
    }
    return listing
  }

  /**
   * Model behind the `default` row of the list this credential's selector shows, null before any
   * read. Never probes: sessions ask at launch, where a CLI start would delay the first message.
   */
  defaultModel(credential?: string): string | null {
    const row = this.fullest.get(keptKey(credential))?.models.find((model) => model.value === 'default')
    return row?.resolvedModel ?? null
  }

  /** An unreadable file only costs the kept lists: the next probes rebuild them. */
  private load(): void {
    if (!this.storePath) return
    try {
      const stored = JSON.parse(readFileSync(this.storePath, 'utf8')) as Record<string, Kept>
      for (const [key, kept] of Object.entries(stored)) {
        if (Array.isArray(kept?.models) && typeof kept.confirmedAt === 'number') this.fullest.set(key, kept)
      }
    } catch {
      // Absent on first start.
    }
  }

  private save(): void {
    if (!this.storePath) return
    try {
      mkdirSync(dirname(this.storePath), { recursive: true })
      // Account e-mails inside: owner only, and renamed into place so a crash leaves no half file.
      const pending = `${this.storePath}.tmp`
      writeFileSync(pending, JSON.stringify(Object.fromEntries(this.fullest)), { mode: 0o600 })
      renameSync(pending, this.storePath)
    } catch (err) {
      console.warn('Could not store the Claude model catalog', err)
    }
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
