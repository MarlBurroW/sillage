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

/**
 * Jetons d'accès aux forges git, un par hôte et par utilisateur.
 *
 * Sillage s'en sert pour cloner. Les `fetch` et `push` lancés par un agent ou depuis un
 * terminal ne passent pas par ici : c'est `sillage-git-credential.mjs`, déclaré dans le
 * `.git/config` du dépôt, qui lit les mêmes lignes au moment où git les réclame.
 */
export class GitCredentialStore {
  constructor(
    private readonly db: Db,
    private readonly key: Buffer,
  ) {}

  /** Sans les jetons : aucune route ne les rend, comme pour les secrets. */
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

  /** Écrit ou remplace : un jeton ne se modifie pas partiellement, il se réécrit. */
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

  /** `undefined` si aucun jeton pour cet hôte ; lève si la ligne ne se déchiffre pas. */
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
