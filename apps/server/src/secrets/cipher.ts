import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Chiffrement au repos du dépôt de secrets et des credentials git.
 *
 * Ce que ça protège : une base copiée, une sauvegarde, un dump SQL qui fuiterait. La
 * clé vit à côté de la base mais dans un autre fichier, donc emporter `sillage.db`
 * seul ne suffit plus.
 *
 * Ce que ça ne protège pas, et qu'il vaut mieux dire que laisser croire : quelqu'un
 * qui lit le disque du serveur lit aussi la clé. C'est un chiffrement au repos, pas un
 * coffre-fort, et Sillage doit de toute façon pouvoir déchiffrer sans intervention
 * humaine pour lancer un serveur MCP au réveil d'une conversation.
 *
 * `sillage-git-credential.mjs` réimplémente le déchiffrement plutôt que d'importer ce
 * module : il est lancé par git, pas par Sillage, et reste volontairement hors du graphe
 * de modules du serveur. Toute évolution du format doit être répercutée là-bas.
 */

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12

/** Les trois parts du chiffré. `iv` et `authTag` n'ont pas à rester secrets, mais
 * doivent être conservés avec le texte chiffré. */
export interface EncryptedValue {
  ciphertext: string
  iv: string
  authTag: string
}

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

export function encryptValue(key: Buffer, value: string): EncryptedValue {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])

  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  }
}

/**
 * Lève si l'authentification GCM échoue : ce n'est pas une valeur absente mais une base
 * altérée ou une clé qui n'est pas la bonne, et l'appelant ne doit pas pouvoir la
 * confondre avec un nom mal orthographié.
 */
export function decryptValue(key: Buffer, value: EncryptedValue): string {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(value.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(value.authTag, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}
