/** Sillage git credential helper. Git invokes it for authentication in Sillage clones: agent fetches, terminal pushes and cloning itself. Reads hosts from stdin and returns username/token pairs. Keep `.mjs` outside the compiled server graph, like bundled MCP, because git launches it directly and accidental imports must not bundle half the application. Reads the database and decrypts locally instead of receiving environment tokens or calling HTTP: no circulating or plaintext disk secrets, and revocation applies on the next git call. Duplicates `secrets/cipher.ts` encryption format; changes there must be mirrored here. */
import { createDecipheriv } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import Database from 'better-sqlite3'

const ALGORITHM = 'aes-256-gcm'

function argValue(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

/** Operation is the final argument: git appends it after Sillage's configured arguments. Only `get` expects replies. Accept `store` and `erase` silently because credentials belong to Sillage and git must not mutate them. Error exits would fail the git operation itself. */
const operation = process.argv[process.argv.length - 1]
if (operation !== 'get') process.exit(0)

/** Protocol keys arrive as `key=value`, terminated by a blank line. */
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

// host includes the port when present, whereas credentials are
// stored against the host alone.
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

// No credential for this host: silent exit lets git continue with its own helpers
// and eventually its ordinary authentication error.
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
  // Undecryptable existing rows are not missing credentials: the key does not match
  // the database. Explain this; otherwise git reports generic authentication failure
  // and obscures the real cause.
  console.error(
    `sillage-git-credential : la credential de ${hostname} ne se déchiffre pas (${err.message}). ` +
      'La clé de chiffrement ne correspond pas à la base.',
  )
  process.exit(1)
}

process.stdout.write(`username=${row.username}\npassword=${token}\n`)
