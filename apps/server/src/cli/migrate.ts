import { openDatabase } from '@sillage/db'
import { loadConfig } from '../config.js'
import { acquireInstanceLock } from '../instance/lock.js'
import { migrationsFolder, runPendingMigrations } from '../migrations.js'
import { CURRENT_VERSION } from '../update/version.js'

const config = loadConfig()
// Same lock as the daemon: migrating a database it serves would change its schema underneath it.
const lock = await acquireInstanceLock(config.paths.database, { role: 'migrate', version: CURRENT_VERSION, waitMs: 0 })
const { db, sqlite } = openDatabase(config.paths.database)
runPendingMigrations(db, migrationsFolder())
sqlite.close()
lock.release()
console.log(`Migrations appliquées sur ${config.paths.database}`)
