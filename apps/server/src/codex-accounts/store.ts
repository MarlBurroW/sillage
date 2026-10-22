import { randomUUID } from 'node:crypto'
import { and, asc, eq } from 'drizzle-orm'
import { codexAccounts, type CodexAccountRow, type Db } from '@sillage/db'
import type { CodexAccount } from '@sillage/protocol'

/** Account information from the latest Codex read, retained in the row. */
export interface CodexAccountIdentity {
  authMode: 'chatgpt' | 'apiKey' | null
  email: string | null
  planType: string | null
}

function toDto(row: CodexAccountRow): CodexAccount {
  return {
    id: row.id,
    label: row.label,
    status: row.authMode ? 'ready' : 'pending',
    authMode: row.authMode ?? null,
    email: row.email ?? null,
    planType: row.planType ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** Additional Codex account rows. Homes and authentication live separately in `CodexAccountHomes`; rows hold only labels and observed identity. */
export class CodexAccountStore {
  constructor(private readonly db: Db) {}

  list(ownerId: string): CodexAccount[] {
    return this.db
      .select()
      .from(codexAccounts)
      .where(eq(codexAccounts.ownerId, ownerId))
      .orderBy(asc(codexAccounts.label))
      .all()
      .map(toDto)
  }

  find(ownerId: string, id: string): CodexAccount | undefined {
    const row = this.db
      .select()
      .from(codexAccounts)
      .where(and(eq(codexAccounts.ownerId, ownerId), eq(codexAccounts.id, id)))
      .get()
    return row ? toDto(row) : undefined
  }

  labelFree(ownerId: string, label: string, exceptId?: string): boolean {
    const existing = this.db
      .select({ id: codexAccounts.id })
      .from(codexAccounts)
      .where(and(eq(codexAccounts.ownerId, ownerId), eq(codexAccounts.label, label)))
      .get()
    return !existing || existing.id === exceptId
  }

  create(ownerId: string, label: string): CodexAccount {
    const now = Date.now()
    const id = randomUUID()
    this.db.insert(codexAccounts).values({ id, ownerId, label, createdAt: now, updatedAt: now }).run()
    return this.find(ownerId, id)!
  }

  rename(ownerId: string, id: string, label: string): boolean {
    if (!this.find(ownerId, id)) return false
    this.db.update(codexAccounts).set({ label, updatedAt: Date.now() }).where(eq(codexAccounts.id, id)).run()
    return true
  }

  /** Stores Codex account information; null `authMode` means logged out. */
  setIdentity(id: string, identity: CodexAccountIdentity): void {
    this.db
      .update(codexAccounts)
      .set({ ...identity, updatedAt: Date.now() })
      .where(eq(codexAccounts.id, id))
      .run()
  }

  delete(ownerId: string, id: string): boolean {
    if (!this.find(ownerId, id)) return false
    this.db.delete(codexAccounts).where(eq(codexAccounts.id, id)).run()
    return true
  }
}
