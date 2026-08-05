/**
 * Helper de credentials git de Sillage.
 *
 * Git l'interroge chaque fois qu'un dépôt cloné par Sillage a besoin de s'authentifier :
 * le `fetch` d'un agent, le `push` que tu lances dans un terminal, le clone lui-même.
 * Il reçoit l'hôte sur son entrée standard et rend le couple utilisateur / jeton.
 *
 * En `.mjs` plutôt qu'en TypeScript compilé, comme le serveur MCP intégré : le process
 * est lancé par git, pas par Sillage, et le garder hors du graphe de modules du serveur
 * évite qu'il n'embarque un jour la moitié de l'application par un import distrait.
 *
 * Il lit la base et déchiffre lui-même, plutôt que de recevoir un jeton par son
 * environnement ou d'appeler l'API HTTP. Rien à faire circuler, rien à écrire en clair
 * sur le disque, et révoquer une credential dans Sillage prend effet au prochain appel
 * de git. Le format de chiffrement est celui de `secrets/cipher.ts`, réimplémenté ici :
 * toute évolution là-bas doit être répercutée ici.
 */
import { createDecipheriv } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import Database from 'better-sqlite3'

const ALGORITHM = 'aes-256-gcm'

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

/**
 * L'opération est le dernier argument, et pas le premier : git l'ajoute à la fin de la
 * commande configurée, derrière les arguments que Sillage y a mis.
 *
 * Il n'attend une réponse que pour `get`. `store` et `erase` doivent être acceptés en
 * silence : les credentials vivent dans Sillage, et git n'a rien à y écrire ni à en
 * effacer. Sortir en erreur ferait échouer l'opération git elle-même.
 */
const operation = process.argv[process.argv.length - 1]
if (operation !== 'get') process.exit(0)

/** Les clés du protocole arrivent en `clé=valeur`, terminées par une ligne vide. */
async function readRequest() {
  const request = {}
  const lines = createInterface({ input: process.stdin })

  for await (const line of lines) {
    if (line === '') break
    const separator = line.indexOf('=')
    if (separator > 0) request[line.slice(0, separator)] = line.slice(separator + 1)
  }
  return request
}

const request = await readRequest()
const host = (request.host ?? '').toLowerCase()
if (!host) process.exit(0)

// Le port fait partie de `host` quand il y en a un, alors que la credential est
// enregistrée sur l'hôte seul.
const hostname = host.replace(/:\d+$/, '')

const databasePath = argValue('--db')
const keyPath = argValue('--key')
const ownerId = argValue('--owner')
if (!databasePath || !keyPath || !ownerId) {
  console.error('sillage-git-credential : --db, --key et --owner sont requis.')
  process.exit(1)
}

const db = new Database(databasePath, { readonly: true, fileMustExist: true })
const row = db
  .prepare(
    'SELECT username, ciphertext, iv, auth_tag AS authTag FROM git_credentials' +
      ' WHERE owner_id = ? AND host = ?',
  )
  .get(ownerId, hostname)
db.close()

// Aucune credential pour cet hôte : sortir muet laisse git suivre son cours, essayer
// ses propres helpers, et finir sur son message d'authentification habituel.
if (!row) process.exit(0)

const key = Buffer.from(readFileSync(keyPath, 'utf8').trim(), 'base64')
const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(row.iv, 'base64'))
decipher.setAuthTag(Buffer.from(row.authTag, 'base64'))

let token
try {
  token = Buffer.concat([
    decipher.update(Buffer.from(row.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8')
} catch (err) {
  // Une ligne présente qui ne se déchiffre pas n'est pas une credential absente : c'est
  // une clé qui ne correspond pas à la base. Le dire, sinon git affiche un banal refus
  // d'authentification et la vraie cause reste introuvable.
  console.error(
    `sillage-git-credential : la credential de ${hostname} ne se déchiffre pas (${err.message}). ` +
      'La clé de chiffrement ne correspond pas à la base.',
  )
  process.exit(1)
}

process.stdout.write(`username=${row.username}\npassword=${token}\n`)
