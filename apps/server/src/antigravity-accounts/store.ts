import { randomUUID } from 'node:crypto'
import { and, asc, eq } from 'drizzle-orm'
import { antigravityAccounts, type AntigravityAccountRow, type Db } from '@sillage/db'
import type { AntigravityAccount } from '@sillage/protocol'

/** Account information from Antigravity's latest read, retained in the row. */
export interface AntigravityAccountIdentity {
  authMode: 'oauth-personal' | 'oauth-business' | 'gemini-api-key' | 'agent-platform' | null
  email: string | null
  plan: string | null
}

function toDto(row: AntigravityAccountRow): AntigravityAccount {
  return {
    id: row.id,
    label: row.label,
    status: row.authMode ? 'ready' : 'pending',
    authMode: row.authMode ?? null,
    email: row.email ?? null,
    plan: row.plan ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** Additional Antigravity account rows. Homes and authentication live separately in `AntigravityAccountHomes`; rows hold only labels and observed identity. */
export class AntigravityAccountStore {
  constructor(private readonly db: Db) {}

  ownerOf(id: string): string {
    const row = this.db.select({ ownerId: antigravityAccounts.ownerId }).from(antigravityAccounts).where(eq(antigravityAccounts.id, id)).get()
    if (!row) throw new Error('Unknown Google account.')
    return row.ownerId
  }

  list(ownerId: string): AntigravityAccount[] {
    return this.db
      .select()
      .from(antigravityAccounts)
      .where(eq(antigravityAccounts.ownerId, ownerId))
      .orderBy(asc(antigravityAccounts.label))
      .all()
      .map(toDto)
  }

  find(ownerId: string, id: string): AntigravityAccount | undefined {
    const row = this.db
      .select()
      .from(antigravityAccounts)
      .where(and(eq(antigravityAccounts.ownerId, ownerId), eq(antigravityAccounts.id, id)))
      .get()
    return row ? toDto(row) : undefined
  }

  /** Without owner checks for operations continuing logins already authorized by routes. */
  findById(id: string): AntigravityAccount | undefined {
    const row = this.db.select().from(antigravityAccounts).where(eq(antigravityAccounts.id, id)).get()
    return row ? toDto(row) : undefined
  }

  labelFree(ownerId: string, label: string, exceptId?: string): boolean {
    const existing = this.db
      .select({ id: antigravityAccounts.id })
      .from(antigravityAccounts)
      .where(and(eq(antigravityAccounts.ownerId, ownerId), eq(antigravityAccounts.label, label)))
      .get()
    return !existing || existing.id === exceptId
  }

  create(ownerId: string, label: string): AntigravityAccount {
    const now = Date.now()
    const id = randomUUID()
    this.db.insert(antigravityAccounts).values({ id, ownerId, label, createdAt: now, updatedAt: now }).run()
    return this.find(ownerId, id)!
  }

  rename(ownerId: string, id: string, label: string): boolean {
    if (!this.find(ownerId, id)) return false
    this.db.update(antigravityAccounts).set({ label, updatedAt: Date.now() }).where(eq(antigravityAccounts.id, id)).run()
    return true
  }

  /** Stores Antigravity account information; null `authMode` means logged out. */
  setIdentity(id: string, identity: AntigravityAccountIdentity): void {
    this.db
      .update(antigravityAccounts)
      .set({ ...identity, updatedAt: Date.now() })
      .where(eq(antigravityAccounts.id, id))
      .run()
  }

  delete(ownerId: string, id: string): boolean {
    if (!this.find(ownerId, id)) return false
    this.db.delete(antigravityAccounts).where(eq(antigravityAccounts.id, id)).run()
    return true
  }
}
