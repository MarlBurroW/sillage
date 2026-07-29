import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { and, asc, eq, lt } from 'drizzle-orm'
import { apiIdempotency, apiTokens, users, type ApiTokenRow, type Db, type UserRow } from '@sillage/db'
import {
  API_TOKEN_PREFIX,
  type AgentKind,
  type ApiScope,
  type ApiTokenDto,
} from '@sillage/protocol'

/**
 * Le secret fait 32 octets d'aléa : assez d'entropie pour qu'un SHA-256 suffise, là où
 * un mot de passe exigerait Argon2. C'est le même raisonnement que pour les sessions.
 */
const SECRET_BYTES = 32
/** Assez pour distinguer deux jetons dans une liste, trop peu pour aider à en deviner un. */
const HINT_LENGTH = 6
/** Écrire la date d'usage à chaque requête ferait une écriture par appel pour rien. */
const LAST_USED_THROTTLE_MS = 60 * 1000
/** Durée pendant laquelle une clé d'idempotence protège encore d'un doublon. */
const KEY_TTL_MS = 7 * 24 * 60 * 60 * 1000

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex')
}

export interface ApiTokenIdentity {
  token: ApiTokenRow
  user: UserRow
}

export function apiTokenToDto(row: ApiTokenRow): ApiTokenDto {
  return {
    id: row.id,
    label: row.label,
    hint: row.hint,
    scopes: JSON.parse(row.scopes) as ApiScope[],
    projectIds: JSON.parse(row.projectIds) as string[],
    agent: row.agent,
    config: JSON.parse(row.config) as unknown,
    webhookUrl: row.webhookUrl,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
  }
}

export interface NewApiToken {
  userId: string
  label: string
  scopes: ApiScope[]
  projectIds: string[]
  agent: AgentKind
  config: unknown
  expiresAt: number | null
  webhookUrl: string | null
}

/**
 * Retourne le secret d'authentification en clair, qui n'existera plus nulle part après
 * cet appel. Le secret de webhook est lui toujours généré, même sans URL : une tâche
 * peut en déclarer une plus tard, et il faut alors un secret déjà connu de l'appelant.
 */
export function createApiToken(db: Db, input: NewApiToken): { row: ApiTokenRow; secret: string } {
  const random = randomBytes(SECRET_BYTES).toString('base64url')
  const secret = `${API_TOKEN_PREFIX}${random}`
  const webhookSecret = `whsec_${randomBytes(SECRET_BYTES).toString('base64url')}`

  const row: ApiTokenRow = {
    id: randomUUID(),
    tokenHash: hashSecret(secret),
    hint: random.slice(0, HINT_LENGTH),
    label: input.label,
    userId: input.userId,
    scopes: JSON.stringify(input.scopes),
    projectIds: JSON.stringify(input.projectIds),
    agent: input.agent,
    config: JSON.stringify(input.config),
    webhookUrl: input.webhookUrl,
    webhookSecret,
    createdAt: Date.now(),
    lastUsedAt: null,
    expiresAt: input.expiresAt,
    revokedAt: null,
  }
  db.insert(apiTokens).values(row).run()

  return { row, secret }
}

/**
 * Résout un `Authorization: Bearer` en jeton et en utilisateur.
 *
 * Un jeton révoqué ou expiré est traité comme inconnu : l'appelant reçoit la même
 * réponse dans les trois cas, et n'apprend rien de la base en tâtonnant.
 */
export function resolveApiToken(db: Db, secret: string): ApiTokenIdentity | null {
  if (!secret.startsWith(API_TOKEN_PREFIX)) return null

  const row = db
    .select({ token: apiTokens, user: users })
    .from(apiTokens)
    .innerJoin(users, eq(users.id, apiTokens.userId))
    .where(eq(apiTokens.tokenHash, hashSecret(secret)))
    .get()

  if (!row) return null
  if (row.token.revokedAt !== null) return null

  const now = Date.now()
  if (row.token.expiresAt !== null && row.token.expiresAt <= now) return null

  if (row.token.lastUsedAt === null || now - row.token.lastUsedAt > LAST_USED_THROTTLE_MS) {
    db.update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, row.token.id)).run()
  }

  return { token: row.token, user: row.user }
}

/** Le secret arrive en `Authorization: Bearer <secret>`, casse de l'en-tête indifférente. */
export function bearerSecret(header: string | undefined): string | null {
  if (!header) return null
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim())
  return match?.[1] ?? null
}

export function listApiTokens(db: Db, userId: string): ApiTokenRow[] {
  return db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.userId, userId))
    .orderBy(asc(apiTokens.createdAt))
    .all()
}

/**
 * Retire les clés d'idempotence trop vieilles pour servir.
 *
 * Une clé ne protège que le temps où un appelant peut encore réessayer ; passé une
 * semaine, elle ne fait plus que grossir la table. Une réservation restée sans
 * conversation part avec, sinon un serveur tué pendant une création bloquerait sa clé
 * en « création en cours » à jamais.
 */
export function purgeIdempotencyKeys(db: Db): void {
  db.delete(apiIdempotency).where(lt(apiIdempotency.createdAt, Date.now() - KEY_TTL_MS)).run()
}

export function findApiToken(db: Db, id: string, userId: string): ApiTokenRow | undefined {
  return db
    .select()
    .from(apiTokens)
    .where(and(eq(apiTokens.id, id), eq(apiTokens.userId, userId)))
    .get()
}
