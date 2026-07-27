import { openDatabase } from '@sillage/db'
import { loadConfig } from '../config.js'
import { migrationsFolder, runPendingMigrations } from '../migrations.js'

const config = loadConfig()
const { db, sqlite } = openDatabase(config.paths.database)
runPendingMigrations(db, migrationsFolder())
sqlite.close()
console.log(`Migrations appliquées sur ${config.paths.database}`)
