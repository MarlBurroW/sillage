import { createHash, randomBytes } from 'node:crypto'
import { eq, lt } from 'drizzle-orm'
import { authSessions, users, type Db, type UserRow } from '@sillage/db'

export const SESSION_COOKIE = 'sillage_session'
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
/** Extend sessions on use when remaining validity falls below this threshold. */
const RENEW_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Stored session-token fingerprint. Exposed so password changes can preserve current sessions without callers duplicating hash implementation details. */
export const sessionTokenHash = hashToken

/** Returns plaintext tokens; only fingerprints are stored. */
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
