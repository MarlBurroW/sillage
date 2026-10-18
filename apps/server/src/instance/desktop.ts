import { randomBytes, randomUUID } from 'node:crypto'
import { closeSync, writeSync } from 'node:fs'
import { userInfo } from 'node:os'
import { asc, eq } from 'drizzle-orm'
import { authSessions, users, type Db, type UserRow } from '@sillage/db'
import { hashPassword } from '../auth/passwords.js'
import { createSession } from '../auth/sessions.js'

/**
 * Descripteur hérité du lanceur de bureau, par lequel le serveur lui remet son adresse
 * et la session de l'utilisateur. Lu à l'import, comme le profil, avant le ménage de
 * l'environnement.
 */
const HANDSHAKE_FD = Number(process.env.SILLAGE_HANDSHAKE_FD)

/**
 * Ouvre la session de l'unique utilisateur d'une instance de bureau.
 *
 * Pas de mot de passe : le poste est déjà celui de l'utilisateur. Le compte naît au
 * premier démarrage avec un mot de passe aléatoire que personne ne connaît, ce qui garde
 * la page de connexion fermée. La session repart à chaque lancement et les précédentes
 * tombent avec : un cookie resté sur le disque ne vaut plus rien une fois l'app quittée.
 */
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
  return row
}

/**
 * Remet au lanceur le port d'écoute et la session, sur une ligne JSON, puis ferme le
 * descripteur : la session ne passe ni par le réseau ni par les journaux, et aucun
 * processus enfant n'hérite du canal.
 */
export function announceToLauncher(port: number, session: string): void {
  if (!Number.isInteger(HANDSHAKE_FD) || HANDSHAKE_FD < 3) {
    throw new Error("Profil desktop sans lanceur : SILLAGE_HANDSHAKE_FD doit désigner le canal hérité de l'application.")
  }
  writeSync(HANDSHAKE_FD, `${JSON.stringify({ port, session })}\n`)
  closeSync(HANDSHAKE_FD)
}

/**
 * Retire de l'environnement ce que le lanceur n'adressait qu'à ce processus.
 *
 * Agents et terminaux héritent de `process.env` : un Sillage lancé depuis un terminal de
 * l'application se croirait sinon instance de bureau, écrirait dans un descripteur qui
 * n'est pas le sien, et partagerait la base de l'application. Appelé après
 * `loadConfig`, qui a déjà lu ces variables.
 */
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
