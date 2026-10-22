import { randomUUID } from 'node:crypto'
import { and, asc, eq } from 'drizzle-orm'
import { claudeAccounts, type Db } from '@sillage/db'
import { claudeSecretKind, type ClaudeAccount, type ClaudeAccountKind } from '@sillage/protocol'
import { decryptValue, encryptValue } from '../secrets/cipher.js'
import type { ClaudeAccountGauges } from './gauges.js'

/** Additional Claude account secrets, per account and user. Session managers load selected secrets at conversation launch into CLI environments; routes return only labels and secret kinds, like git credentials. */
export class ClaudeAccountStore {
  constructor(
    private readonly db: Db,
    private readonly key: Buffer,
    /** Without gauges no accounts have usage data; useful for tests not exercising it. */
    readonly gauges: ClaudeAccountGauges | null = null,
  ) {}

  list(ownerId: string): ClaudeAccount[] {
    return this.db
      .select({
        id: claudeAccounts.id,
        label: claudeAccounts.label,
        kind: claudeAccounts.kind,
        createdAt: claudeAccounts.createdAt,
        updatedAt: claudeAccounts.updatedAt,
      })
      .from(claudeAccounts)
      .where(eq(claudeAccounts.ownerId, ownerId))
      .orderBy(asc(claudeAccounts.label))
      .all()
      .map((row) => ({ ...row, gauge: this.gaugeOf(row.id, row.kind) }))
  }

  /** Account only if owned by this user, without secrets. */
  find(ownerId: string, id: string): ClaudeAccount | undefined {
    return this.list(ownerId).find((account) => account.id === id)
  }

  /** API keys have no subscription: even leftover directories cannot give them gauges. */
  private gaugeOf(id: string, kind: ClaudeAccountKind): ClaudeAccount['gauge'] {
    return kind === 'oauth' ? (this.gauges?.describe(id) ?? null) : null
  }

  /** False when another account owned by this user already has the label. */
  labelFree(ownerId: string, label: string, exceptId?: string): boolean {
    const existing = this.db
      .select({ id: claudeAccounts.id })
      .from(claudeAccounts)
      .where(and(eq(claudeAccounts.ownerId, ownerId), eq(claudeAccounts.label, label)))
      .get()
    return !existing || existing.id === exceptId
  }

  create(ownerId: string, label: string, secret: string): ClaudeAccount {
    const now = Date.now()
    const id = randomUUID()
    const kind = claudeSecretKind(secret)
    this.db
      .insert(claudeAccounts)
      .values({ id, ownerId, label, kind, ...encryptValue(this.key, secret), createdAt: now, updatedAt: now })
      .run()
    return { id, label, kind, gauge: null, createdAt: now, updatedAt: now }
  }

  /** Renames or replaces secrets: expired tokens are rewritten, not corrected. */
  update(ownerId: string, id: string, patch: { label?: string; token?: string }): boolean {
    if (!this.row(ownerId, id)) return false
    this.db
      .update(claudeAccounts)
      .set({
        ...(patch.label === undefined ? {} : { label: patch.label }),
        ...(patch.token === undefined
          ? {}
          : { kind: claudeSecretKind(patch.token), ...encryptValue(this.key, patch.token) }),
        updatedAt: Date.now(),
      })
      .where(eq(claudeAccounts.id, id))
      .run()
    return true
  }

  delete(ownerId: string, id: string): boolean {
    if (!this.row(ownerId, id)) return false
    this.db.delete(claudeAccounts).where(eq(claudeAccounts.id, id)).run()
    // Remove gauge logins too: removed subscriptions must no longer be queried.
    this.gauges?.forget(id)
    return true
  }

  /** Plaintext secret and kind for session environments. Require owners alongside IDs: shared project configurations may reference others' accounts, which must not enter this user's sessions. */
  resolveToken(ownerId: string, id: string): { label: string; kind: ClaudeAccountKind; token: string } | undefined {
    const row = this.row(ownerId, id)
    if (!row) return undefined
    try {
      return { label: row.label, kind: row.kind, token: decryptValue(this.key, row) }
    } catch (err) {
      throw new Error(
        `Le secret du compte Claude « ${row.label} » n'a pas pu être déchiffré : ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          'La clé de chiffrement ne correspond pas à la base, ou la ligne a été modifiée.',
      )
    }
  }

  private row(ownerId: string, id: string) {
    return this.db
      .select()
      .from(claudeAccounts)
      .where(and(eq(claudeAccounts.ownerId, ownerId), eq(claudeAccounts.id, id)))
      .get()
  }
}
