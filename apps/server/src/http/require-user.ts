import type { UserRow } from '@sillage/db'
import type { FastifyRequest } from 'fastify'
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
