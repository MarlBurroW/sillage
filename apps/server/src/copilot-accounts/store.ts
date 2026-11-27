import { randomUUID } from 'node:crypto'
import { and, asc, eq } from 'drizzle-orm'
import { copilotAccounts, type CopilotAccountRow, type Db } from '@sillage/db'
import type { CopilotAccount } from '@sillage/protocol'

function toDto(row: CopilotAccountRow): CopilotAccount {
  return {
    id: row.id,
    label: row.label,
    status: row.login ? 'ready' : 'pending',
    login: row.login ?? null,
    host: row.host ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** Additional Copilot account rows. Homes and sign-ins live in `CopilotAccountHomes`; rows hold only labels and the observed login. */
export class CopilotAccountStore {
  constructor(private readonly db: Db) {}

  list(ownerId: string): CopilotAccount[] {
    return this.db
      .select()
      .from(copilotAccounts)
      .where(eq(copilotAccounts.ownerId, ownerId))
      .orderBy(asc(copilotAccounts.label))
      .all()
      .map(toDto)
  }

  find(ownerId: string, id: string): CopilotAccount | undefined {
    const row = this.db
      .select()
      .from(copilotAccounts)
      .where(and(eq(copilotAccounts.ownerId, ownerId), eq(copilotAccounts.id, id)))
      .get()
    return row ? toDto(row) : undefined
  }

  labelFree(ownerId: string, label: string, exceptId?: string): boolean {
    const existing = this.db
      .select({ id: copilotAccounts.id })
      .from(copilotAccounts)
      .where(and(eq(copilotAccounts.ownerId, ownerId), eq(copilotAccounts.label, label)))
      .get()
    return !existing || existing.id === exceptId
  }

  create(ownerId: string, label: string): CopilotAccount {
    const now = Date.now()
    const id = randomUUID()
    this.db.insert(copilotAccounts).values({ id, ownerId, label, createdAt: now, updatedAt: now }).run()
    return this.find(ownerId, id)!
  }

  rename(ownerId: string, id: string, label: string): boolean {
    if (!this.find(ownerId, id)) return false
    this.db.update(copilotAccounts).set({ label, updatedAt: Date.now() }).where(eq(copilotAccounts.id, id)).run()
    return true
  }

  /** Stores the login Copilot reported; null means signed out. */
  setIdentity(id: string, identity: { login: string; host: string } | null): void {
    this.db
      .update(copilotAccounts)
      .set({ login: identity?.login ?? null, host: identity?.host ?? null, updatedAt: Date.now() })
      .where(eq(copilotAccounts.id, id))
      .run()
  }

  delete(ownerId: string, id: string): boolean {
    if (!this.find(ownerId, id)) return false
    this.db.delete(copilotAccounts).where(eq(copilotAccounts.id, id)).run()
    return true
  }
}
