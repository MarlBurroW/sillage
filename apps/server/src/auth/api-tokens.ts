import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { and, asc, eq, lt } from 'drizzle-orm'
import { apiIdempotency, apiTokens, users, type ApiTokenRow, type Db, type UserRow } from '@sillage/db'
import {
  API_TOKEN_PREFIX,
  type AgentKind,
  type ApiExecutionPolicy,
  apiExecutionPolicySchema,
  type ApiScope,
  type ApiTokenDto,
} from '@sillage/protocol'

/** Secrets contain 32 random bytes: enough entropy for SHA-256 where passwords need Argon2, following the session-token rationale. */
const SECRET_BYTES = 32
/** Enough to distinguish listed tokens, too little to help guess them. */
const HINT_LENGTH = 6
/** Writing last-use dates on every request would add a pointless write per call. */
const LAST_USED_THROTTLE_MS = 60 * 1000
/** Duration for which idempotency keys prevent duplicate requests. */
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
    executionPolicy: readExecutionPolicy(row),
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
  executionPolicy?: ApiExecutionPolicy | null
  expiresAt: number | null
  webhookUrl: string | null
}

/** Returns plaintext authentication secrets, unavailable anywhere afterward. Always generate webhook secrets even without URLs: tasks may add URLs later and need a secret already known to callers. */
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
    executionPolicy: input.executionPolicy ? JSON.stringify(input.executionPolicy) : null,
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

/** Resolves `Authorization: Bearer` into tokens and users. Revoked, expired and unknown tokens receive identical responses, revealing nothing to probing callers. */
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

/** Secrets arrive as `Authorization: Bearer <secret>`; header casing is irrelevant. */
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

/** Deletes idempotency keys too old to help. After a week, retries are no longer relevant and keys only inflate storage. Also remove reservations without conversations so interrupted creation cannot leave keys permanently 'creating'. */
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

/** Validate stored policies too: corrupted restrictions must fail closed. */
export function readExecutionPolicy(token: Pick<ApiTokenRow, 'executionPolicy'>): ApiExecutionPolicy | null {
  return token.executionPolicy ? apiExecutionPolicySchema.parse(JSON.parse(token.executionPolicy)) : null
}
