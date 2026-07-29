import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { eq } from 'drizzle-orm'
import { secrets, type Db } from '@sillage/db'

/**
 * Dépôt de secrets, chiffré au repos.
 *
 * Ce que ça protège : une base copiée, une sauvegarde, un dump SQL qui fuiterait. La
 * clé vit à côté de la base mais dans un autre fichier, donc emporter `sillage.db`
 * seul ne suffit plus.
 *
 * Ce que ça ne protège pas, et qu'il vaut mieux dire que laisser croire : quelqu'un
 * qui lit le disque du serveur lit aussi la clé. C'est un chiffrement au repos, pas un
 * coffre-fort, et Sillage doit de toute façon pouvoir déchiffrer sans intervention
 * humaine pour lancer un serveur MCP au réveil d'une conversation.
 */

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12

/**
 * Charge la clé, ou la crée au premier démarrage.
 *
 * Écrite en 0600 et non dans la base : le point de tout l'exercice est justement
 * qu'elle ne voyage pas avec elle.
 */
export function loadOrCreateKey(dataDir: string): Buffer {
  const path = join(dataDir, 'secret.key')

  if (existsSync(path)) {
    const key = Buffer.from(readFileSync(path, 'utf8').trim(), 'base64')
    if (key.length !== KEY_BYTES) {
      throw new Error(
        `Clé de chiffrement invalide dans ${path} : ${key.length} octets au lieu de ${KEY_BYTES}. ` +
          'La restaurer depuis une sauvegarde, ou supprimer le fichier pour repartir de zéro, ' +
          'ce qui rend illisibles les secrets déjà enregistrés.',
      )
    }
    return key
  }

  const key = randomBytes(KEY_BYTES)
  // `mode` à la création puis `chmod` : le premier ne suffit pas si l'umask du service
  // est plus permissif, et un fichier de clé lisible par tous ne vaut rien.
  writeFileSync(path, key.toString('base64'), { mode: 0o600 })
  chmodSync(path, 0o600)
  return key
}

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
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv(ALGORITHM, this.key, iv)
    const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])

    const now = Date.now()
    const row = {
      name,
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      createdAt: now,
      updatedAt: now,
    }

    this.db
      .insert(secrets)
      .values(row)
      .onConflictDoUpdate({
        target: secrets.name,
        set: {
          ciphertext: row.ciphertext,
          iv: row.iv,
          authTag: row.authTag,
          updatedAt: now,
        },
      })
      .run()
  }

  delete(name: string): boolean {
    const existing = this.db.select().from(secrets).where(eq(secrets.name, name)).get()
    if (!existing) return false
    this.db.delete(secrets).where(eq(secrets.name, name)).run()
    return true
  }

  /**
   * Déchiffre, ou rend `undefined` si le secret n'existe pas.
   *
   * Une authentification GCM qui échoue n'est pas un secret absent mais une base
   * altérée ou une clé qui n'est pas la bonne : elle lève, pour que la cause soit
   * lisible dans les logs plutôt que confondue avec un nom mal orthographié.
   */
  resolve(name: string): string | undefined {
    const row = this.db.select().from(secrets).where(eq(secrets.name, name)).get()
    if (!row) return undefined

    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(row.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(row.authTag, 'base64'))
    try {
      return Buffer.concat([
        decipher.update(Buffer.from(row.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf8')
    } catch (err) {
      throw new Error(
        `Le secret « ${name} » n'a pas pu être déchiffré : ${err instanceof Error ? err.message : String(err)}. ` +
          'La clé de chiffrement ne correspond pas à la base, ou la ligne a été modifiée.',
      )
    }
  }
}
