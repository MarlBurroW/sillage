import type { ApiTokenRow, UserRow } from '@sillage/db'
import type { FastifyRequest } from 'fastify'
import type { ApiScope } from '@sillage/protocol'
import { forbidden, unauthorized } from './errors.js'

export function requireUser(request: FastifyRequest): UserRow {
  if (!request.user) throw unauthorized()
  return request.user
}

export function requireAdmin(request: FastifyRequest): UserRow {
  const user = requireUser(request)
  if (!user.isAdmin) throw forbidden('admin_only', 'Administrators only.')
  return user
}

/** Caller of an `/api/v1` route with its required scope. The global hook already ensures a token exists under this prefix; this guard narrows its type and checks the route-specific scope. */
export function requireScope(
  request: FastifyRequest,
  scope: ApiScope,
): { token: ApiTokenRow; user: UserRow } {
  const token = request.apiToken
  const user = request.user
  if (!token || !user) throw unauthorized()

  const scopes = JSON.parse(token.scopes) as ApiScope[]
  if (!scopes.includes(scope)) {
    throw forbidden('scope_missing', 'This token is missing the {scope} scope.', { scope })
  }
  return { token, user }
}
