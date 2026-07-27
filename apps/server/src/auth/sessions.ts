import { createHash, randomBytes } from 'node:crypto'
import { eq, lt } from 'drizzle-orm'
import { authSessions, users, type Db, type UserRow } from '@sillage/db'

export const SESSION_COOKIE = 'sillage_session'
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** En dessous de ce reste de validité, on prolonge la session à l'usage. */
const RENEW_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Empreinte d'un token de session, telle qu'elle est stockée.
 *
 * Exposée pour qu'un changement de mot de passe puisse épargner la session courante,
 * sans que l'appelant ait à redire comment le hachage est fait.
 */
export const sessionTokenHash = hashToken

/** Retourne le token en clair, seul son empreinte est stockée. */
export async function createSession(
  db: Db,
  userId: string,
  userAgent: string | undefined,
): Promise<{ token: string; expiresAt: number }> {
  const token = randomBytes(32).toString('base64url')
  const now = Date.now()
  const expiresAt = now + SESSION_TTL_MS

  await db.insert(authSessions).values({
    tokenHash: hashToken(token),
    userId,
    createdAt: now,
    expiresAt,
    userAgent: userAgent ?? null,
  })

  return { token, expiresAt }
}

export async function resolveSession(db: Db, token: string): Promise<UserRow | null> {
  const tokenHash = hashToken(token)
  const rows = await db
    .select({ user: users, expiresAt: authSessions.expiresAt })
    .from(authSessions)
    .innerJoin(users, eq(users.id, authSessions.userId))
    .where(eq(authSessions.tokenHash, tokenHash))
    .limit(1)

  const row = rows[0]
  if (!row) return null

  const now = Date.now()
  if (row.expiresAt <= now) {
    await db.delete(authSessions).where(eq(authSessions.tokenHash, tokenHash))
    return null
  }

  if (row.expiresAt - now < RENEW_THRESHOLD_MS) {
    await db
      .update(authSessions)
      .set({ expiresAt: now + SESSION_TTL_MS })
      .where(eq(authSessions.tokenHash, tokenHash))
  }

  return row.user
}

export async function destroySession(db: Db, token: string): Promise<void> {
  await db.delete(authSessions).where(eq(authSessions.tokenHash, hashToken(token)))
}

export async function purgeExpiredSessions(db: Db): Promise<void> {
  await db.delete(authSessions).where(lt(authSessions.expiresAt, Date.now()))
}
