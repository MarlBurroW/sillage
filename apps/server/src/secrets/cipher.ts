import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** At-rest encryption for secrets and git credentials. Protects copied databases, backups and leaked SQL dumps: the key lives beside the database in a separate file, so `sillage.db` alone is insufficient. Does not protect against server-disk access, which also exposes keys. This is at-rest encryption rather than a vault; Sillage must decrypt unattended when conversations wake and launch MCP servers. Standalone `sillage-git-credential.mjs` duplicates decryption outside the server module graph; format changes must be mirrored there. */

const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12

/** Three ciphertext components. `iv` and `authTag` need not remain secret but must accompany ciphertext. */
export interface EncryptedValue {
  ciphertext: string
  iv: string
  authTag: string
}

/** Loads keys or creates them at first startup. Store as 0600 outside the database precisely so copied databases do not carry keys with them. */
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
  // Set `mode` on creation then `chmod`: the former is insufficient with permissive
  // service umasks, and world-readable key files offer no protection.
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

/** Throws on failed GCM authentication: this indicates altered databases or incorrect keys, not absent values. Callers must distinguish it from misspelled names. */
export function decryptValue(key: Buffer, value: EncryptedValue): string {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(value.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(value.authTag, 'base64'))
  return Buffer.concat([
    decipher.update(Buffer.from(value.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8')
}
