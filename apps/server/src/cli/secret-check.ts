import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { mcpServers, openDatabase } from '@sillage/db'
import { resolveMcpServers, secretsUsedBy } from '../agents/mcp-registry.js'
import { migrationsFolder, runPendingMigrations } from '../migrations.js'
import { SecretStore, loadOrCreateKey } from '../secrets/store.js'

/**
 * Contrôle du chemin des secrets, sur une base jetable.
 *
 * Contrairement à `mcp-probe`, cette vérification ne lance aucun CLI et ne coûte aucun
 * tour de modèle : elle est déterministe et peut se relancer à volonté. Elle couvre ce
 * qu'on ne veut pas découvrir en production, à savoir qu'une valeur chiffrée ne se
 * retrouve pas en clair dans le fichier de base, que la substitution atteint bien
 * l'en-tête transmis, et qu'un secret manquant écarte le serveur en le nommant.
 */

const dir = mkdtempSync(join(tmpdir(), 'sillage-secret-'))
const { db } = openDatabase(join(dir, 'check.db'))
runPendingMigrations(db, migrationsFolder())

const store = new SecretStore(db, loadOrCreateKey(dir))
store.put('GITHUB_TOKEN', 'ghp_valeur_ultra_secrete')

const check = (label: string, ok: boolean, detail = '') =>
  console.log(`${ok ? 'OK   ' : 'ECHEC'} ${label}${detail ? ` -> ${detail}` : ''}`)

check('relecture du secret', store.resolve('GITHUB_TOKEN') === 'ghp_valeur_ultra_secrete')
check('secret absent rend undefined', store.resolve('INCONNU') === undefined)

const dump = readFileSync(join(dir, 'check.db'), 'utf8').includes('ghp_valeur_ultra_secrete')
check('valeur absente du fichier de base', !dump)

const insert = (name: string, headers: Record<string, string>) => {
  const id = randomUUID()
  db.insert(mcpServers)
    .values({
      id,
      name,
      enabled: true,
      transport: JSON.stringify({ type: 'http', url: 'https://api.example.com/mcp', headers }),
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    .run()
  return id
}

const good = insert('github', { Authorization: 'Bearer {{secret.GITHUB_TOKEN}}' })
const bad = insert('cassé', { Authorization: 'Bearer {{secret.ABSENT}}' })

const resolved = resolveMcpServers(db, store, [good, bad])
const header =
  resolved.servers[0]?.transport.type === 'http'
    ? resolved.servers[0].transport.headers.Authorization
    : undefined

check('serveur résolu transmis', resolved.servers.length === 1, resolved.servers[0]?.name)
check('secret substitué', header === 'Bearer ghp_valeur_ultra_secrete', header)
check('serveur au secret manquant écarté', resolved.failures.length === 1)
check(
  'échec nomme le secret',
  resolved.failures[0]?.error.includes('ABSENT') === true,
  resolved.failures[0]?.error,
)

const row = db.select().from(mcpServers).all().find((r) => r.id === good)
check('emploi du secret retrouvé', row !== undefined && secretsUsedBy(row).includes('GITHUB_TOKEN'))

process.exit(0)
