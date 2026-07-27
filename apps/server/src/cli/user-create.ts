import { randomUUID } from 'node:crypto'
import { count, eq } from 'drizzle-orm'
import { openDatabase, users } from '@sillage/db'
import { hashPassword } from '../auth/passwords.js'
import { loadConfig } from '../config.js'
import { migrationsFolder, runPendingMigrations } from '../migrations.js'
import { Prompter } from './prompt.js'

const MIN_PASSWORD_LENGTH = 8

async function main(): Promise<void> {
  const config = loadConfig()
  const { db, sqlite } = openDatabase(config.paths.database)
  runPendingMigrations(db, migrationsFolder())

  const prompt = new Prompter()
  try {
    const username = await prompt.ask("Nom d'utilisateur : ")
    if (!username) throw new Error("Le nom d'utilisateur est obligatoire.")

    const existing = await db.select().from(users).where(eq(users.username, username)).limit(1)
    if (existing.length > 0) throw new Error(`L'utilisateur "${username}" existe déjà.`)

    const displayName = (await prompt.ask(`Nom affiché [${username}] : `)) || username

    const password = await prompt.askHidden('Mot de passe : ')
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`Le mot de passe doit faire au moins ${MIN_PASSWORD_LENGTH} caractères.`)
    }
    if (password !== (await prompt.askHidden('Confirmation : '))) {
      throw new Error('Les deux mots de passe diffèrent.')
    }

    // Le premier compte créé est administrateur d'office : personne ne peut le promouvoir.
    const [tally] = await db.select({ total: count() }).from(users)
    const isFirstUser = (tally?.total ?? 0) === 0
    const isAdmin =
      isFirstUser || (await prompt.ask('Administrateur ? [o/N] : ')).toLowerCase() === 'o'

    await db.insert(users).values({
      id: randomUUID(),
      username,
      passwordHash: await hashPassword(password),
      displayName,
      isAdmin,
      createdAt: Date.now(),
    })

    console.log(`Utilisateur "${username}" créé${isAdmin ? ' (administrateur)' : ''}.`)
  } finally {
    prompt.close()
    sqlite.close()
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
