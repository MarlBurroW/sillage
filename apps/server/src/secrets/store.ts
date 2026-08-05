import { eq } from 'drizzle-orm'
import { secrets, type Db } from '@sillage/db'
import { decryptValue, encryptValue } from './cipher.js'

/**
 * Dépôt de secrets de l'instance, chiffré au repos par `cipher.ts`, qui documente ce
 * que ce chiffrement protège et ce qu'il ne protège pas.
 */
export class SecretStore {
  constructor(
    private readonly db: Db,
    private readonly key: Buffer,
  ) {}

  /** Noms et dates seuls : la valeur ne sort d'ici que par `resolve`. */
  list(): { name: string; createdAt: number; updatedAt: number }[] {
    return this.db
      .select({
        name: secrets.name,
        createdAt: secrets.createdAt,
        updatedAt: secrets.updatedAt,
      })
      .from(secrets)
      .orderBy(secrets.name)
      .all()
  }

  /** Écrit ou remplace. Un secret ne se modifie pas partiellement, il se réécrit. */
  put(name: string, value: string): void {
    const encrypted = encryptValue(this.key, value)
    const now = Date.now()

    this.db
      .insert(secrets)
      .values({ name, ...encrypted, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: secrets.name,
        set: { ...encrypted, updatedAt: now },
      })
      .run()
  }

  delete(name: string): boolean {
    const existing = this.db.select().from(secrets).where(eq(secrets.name, name)).get()
    if (!existing) return false
    this.db.delete(secrets).where(eq(secrets.name, name)).run()
    return true
  }

  /** `undefined` si le secret n'existe pas ; lève si la ligne existe mais ne se déchiffre pas. */
  resolve(name: string): string | undefined {
    const row = this.db.select().from(secrets).where(eq(secrets.name, name)).get()
    if (!row) return undefined

    try {
      return decryptValue(this.key, row)
    } catch (err) {
      throw new Error(
        `Le secret « ${name} » n'a pas pu être déchiffré : ${err instanceof Error ? err.message : String(err)}. ` +
          'La clé de chiffrement ne correspond pas à la base, ou la ligne a été modifiée.',
      )
    }
  }
}
