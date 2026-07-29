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

/**
 * L'appelant d'une route `/api/v1`, avec la portée qu'elle exige.
 *
 * Le hook global garantit déjà la présence du jeton sur ce préfixe ; ce garde le
 * retype et vérifie la portée, qui est propre à chaque route.
 */
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
