import { randomUUID } from 'node:crypto'
import { and, asc, eq } from 'drizzle-orm'
import { grokAccounts, type GrokAccountRow, type Db } from '@sillage/db'
import type { GrokAccount } from '@sillage/protocol'

/** Ce que Grok a dit du compte à la dernière lecture, à retenir sur la ligne. */
export interface GrokAccountIdentity {
  authMode: 'grok' | 'apiKey' | null
  email: string | null
  plan: string | null
}

function toDto(row: GrokAccountRow): GrokAccount {
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

/**
 * Lignes des comptes Grok supplémentaires. Le home et sa connexion sont à côté, dans
 * `GrokAccountHomes` : la ligne ne dit que le libellé et l'identité lue.
 */
export class GrokAccountStore {
  constructor(private readonly db: Db) {}

  list(ownerId: string): GrokAccount[] {
    return this.db
      .select()
      .from(grokAccounts)
      .where(eq(grokAccounts.ownerId, ownerId))
      .orderBy(asc(grokAccounts.label))
      .all()
      .map(toDto)
  }

  find(ownerId: string, id: string): GrokAccount | undefined {
    const row = this.db
      .select()
      .from(grokAccounts)
      .where(and(eq(grokAccounts.ownerId, ownerId), eq(grokAccounts.id, id)))
      .get()
    return row ? toDto(row) : undefined
  }

  /** Sans propriétaire : pour ce qui suit une connexion déjà autorisée par la route. */
  findById(id: string): GrokAccount | undefined {
    const row = this.db.select().from(grokAccounts).where(eq(grokAccounts.id, id)).get()
    return row ? toDto(row) : undefined
  }

  labelFree(ownerId: string, label: string, exceptId?: string): boolean {
    const existing = this.db
      .select({ id: grokAccounts.id })
      .from(grokAccounts)
      .where(and(eq(grokAccounts.ownerId, ownerId), eq(grokAccounts.label, label)))
      .get()
    return !existing || existing.id === exceptId
  }

  create(ownerId: string, label: string): GrokAccount {
    const now = Date.now()
    const id = randomUUID()
    this.db.insert(grokAccounts).values({ id, ownerId, label, createdAt: now, updatedAt: now }).run()
    return this.find(ownerId, id)!
  }

  rename(ownerId: string, id: string, label: string): boolean {
    if (!this.find(ownerId, id)) return false
    this.db.update(grokAccounts).set({ label, updatedAt: Date.now() }).where(eq(grokAccounts.id, id)).run()
    return true
  }

  /** Écrit ce que Grok a dit du compte ; `authMode` null vaut « déconnecté ». */
  setIdentity(id: string, identity: GrokAccountIdentity): void {
    this.db
      .update(grokAccounts)
      .set({ ...identity, updatedAt: Date.now() })
      .where(eq(grokAccounts.id, id))
      .run()
  }

  delete(ownerId: string, id: string): boolean {
    if (!this.find(ownerId, id)) return false
    this.db.delete(grokAccounts).where(eq(grokAccounts.id, id)).run()
    return true
  }
}
