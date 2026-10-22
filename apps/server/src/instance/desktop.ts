import { randomBytes, randomUUID } from 'node:crypto'
import { closeSync, writeSync } from 'node:fs'
import { userInfo } from 'node:os'
import { asc, eq } from 'drizzle-orm'
import { authSessions, users, type Db, type UserRow } from '@sillage/db'
import { hashPassword } from '../auth/passwords.js'
import { createSession } from '../auth/sessions.js'
import { armOnboarding } from '../settings/user-settings.js'

/** Desktop launcher descriptor carrying server address and user session. Read at import like the profile, before environment cleanup. */
const HANDSHAKE_FD = Number(process.env.SILLAGE_HANDSHAKE_FD)

/** Opens the desktop instance's sole user session. No password because the machine already belongs to the user. Create accounts on first startup with unknowable random passwords, keeping login pages closed. Regenerate sessions each launch and invalidate previous ones so disk cookies stop working after quitting. */
export async function openDesktopSession(db: Db): Promise<string> {
  const user = (await firstAdmin(db)) ?? (await createLocalUser(db))
  await db.delete(authSessions).where(eq(authSessions.userId, user.id))
  const { token } = await createSession(db, user.id, 'Sillage Desktop')
  return token
}

async function firstAdmin(db: Db): Promise<UserRow | undefined> {
  const rows = await db.select().from(users).where(eq(users.isAdmin, true)).orderBy(asc(users.createdAt)).limit(1)
  return rows[0]
}

async function createLocalUser(db: Db): Promise<UserRow> {
  const row: UserRow = {
    id: randomUUID(),
    username: 'local',
    passwordHash: await hashPassword(randomBytes(32).toString('base64url')),
    displayName: userInfo().username,
    isAdmin: true,
    createdAt: Date.now(),
  }
  await db.insert(users).values(row)
  // First launch opens the tour in the window without an account step.
  armOnboarding(db, row.id)
  return row
}

/** Sends listening port and session to the launcher as one JSON line, then closes the descriptor. Sessions cross neither network nor logs, and child processes inherit no channel. */
export function announceToLauncher(port: number, session: string): void {
  if (!Number.isInteger(HANDSHAKE_FD) || HANDSHAKE_FD < 3) {
    throw new Error("Profil desktop sans lanceur : SILLAGE_HANDSHAKE_FD doit désigner le canal hérité de l'application.")
  }
  writeSync(HANDSHAKE_FD, `${JSON.stringify({ port, session })}\n`)
  closeSync(HANDSHAKE_FD)
}

/** Removes launcher environment intended only for this process. Agents and terminals inherit `process.env`; otherwise Sillage started inside an app terminal would think itself desktop, write another process's descriptor and share the app database. Called after `loadConfig` reads those values. */
export function scrubLauncherEnv(): void {
  for (const name of [
    'SILLAGE_PROFILE',
    'SILLAGE_HANDSHAKE_FD',
    'SILLAGE_DATA_DIR',
    'SILLAGE_CONFIG',
    'SILLAGE_WEB_ROOT',
    'SILLAGE_HOST',
    'SILLAGE_PORT',
  ]) {
    delete process.env[name]
  }
}
