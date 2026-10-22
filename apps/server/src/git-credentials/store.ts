import { randomUUID } from 'node:crypto'
import { and, asc, eq } from 'drizzle-orm'
import { gitCredentials, type Db } from '@sillage/db'
import { decryptValue, encryptValue } from '../secrets/cipher.js'

export interface GitCredential {
  host: string
  username: string
  createdAt: number
  updatedAt: number
}

/** Git forge access tokens, one per host and user. Sillage uses these when cloning. Agent/terminal fetches and pushes instead invoke `sillage-git-credential.mjs` from repository `.git/config`, reading the same rows on demand. */
export class GitCredentialStore {
  constructor(
    private readonly db: Db,
    private readonly key: Buffer,
  ) {}

  /** Without tokens: no route returns their values, like secrets. */
  list(ownerId: string): GitCredential[] {
    return this.db
      .select({
        host: gitCredentials.host,
        username: gitCredentials.username,
        createdAt: gitCredentials.createdAt,
        updatedAt: gitCredentials.updatedAt,
      })
      .from(gitCredentials)
      .where(eq(gitCredentials.ownerId, ownerId))
      .orderBy(asc(gitCredentials.host))
      .all()
  }

  /** Writes or replaces tokens in full; partial edits are unsupported. */
  put(ownerId: string, host: string, username: string, token: string): void {
    const encrypted = encryptValue(this.key, token)
    const now = Date.now()

    const existing = this.db
      .select({ id: gitCredentials.id })
      .from(gitCredentials)
      .where(and(eq(gitCredentials.ownerId, ownerId), eq(gitCredentials.host, host)))
      .get()

    if (existing) {
      this.db
        .update(gitCredentials)
        .set({ username, ...encrypted, updatedAt: now })
        .where(eq(gitCredentials.id, existing.id))
        .run()
      return
    }

    this.db
      .insert(gitCredentials)
      .values({
        id: randomUUID(),
        ownerId,
        host,
        username,
        ...encrypted,
        createdAt: now,
        updatedAt: now,
      })
      .run()
  }

  delete(ownerId: string, host: string): boolean {
    const existing = this.db
      .select({ id: gitCredentials.id })
      .from(gitCredentials)
      .where(and(eq(gitCredentials.ownerId, ownerId), eq(gitCredentials.host, host)))
      .get()
    if (!existing) return false

    this.db.delete(gitCredentials).where(eq(gitCredentials.id, existing.id)).run()
    return true
  }

  /** `undefined` without a host token; throws for undecryptable rows. */
  resolve(ownerId: string, host: string): { username: string; token: string } | undefined {
    const row = this.db
      .select()
      .from(gitCredentials)
      .where(and(eq(gitCredentials.ownerId, ownerId), eq(gitCredentials.host, host)))
      .get()
    if (!row) return undefined

    try {
      return { username: row.username, token: decryptValue(this.key, row) }
    } catch (err) {
      throw new Error(
        `La credential git de « ${host} » n'a pas pu être déchiffrée : ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          'La clé de chiffrement ne correspond pas à la base, ou la ligne a été modifiée.',
      )
    }
  }
}
