import { randomUUID } from 'node:crypto'
import { and, count, eq, gt, ne } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { authSessions, conversations, projects, users } from '@sillage/db'
import { createUserBodySchema, updateUserBodySchema, type UserDto } from '@sillage/protocol'
import { hashPassword, verifyPassword } from '../../auth/passwords.js'
import { SESSION_COOKIE, sessionTokenHash } from '../../auth/sessions.js'
import type { AppContext } from '../context.js'
import { badRequest, conflict, forbidden, notFound } from '../errors.js'
import { requireAdmin, requireUser } from '../require-user.js'
import { armOnboarding } from '../../settings/user-settings.js'

/** Account administration. Sillage assumes a trusted circle: administrators can create and delete accounts, but all agents run as the same system user. This screen manages instance access, not execution privileges. */
export function registerUserRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Grouped counts: one query per resource rather than three per user. */
  const tallyBy = <T extends { userId: string; total: number }>(rows: T[]): Map<string, number> =>
    new Map(rows.map((row) => [row.userId, row.total]))

  const listUsers = (): UserDto[] => {
    const rows = ctx.db.select().from(users).orderBy(users.username).all()

    const sessions = tallyBy(
      ctx.db
        .select({ userId: authSessions.userId, total: count() })
        .from(authSessions)
        .where(gt(authSessions.expiresAt, Date.now()))
        .groupBy(authSessions.userId)
        .all(),
    )
    const ownedProjects = tallyBy(
      ctx.db
        .select({ userId: projects.ownerId, total: count() })
        .from(projects)
        .groupBy(projects.ownerId)
        .all(),
    )
    const ownedConversations = tallyBy(
      ctx.db
        .select({ userId: conversations.userId, total: count() })
        .from(conversations)
        .groupBy(conversations.userId)
        .all(),
    )

    return rows.map((row) => ({
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      isAdmin: row.isAdmin,
      createdAt: row.createdAt,
      activeSessions: sessions.get(row.id) ?? 0,
      ownedProjects: ownedProjects.get(row.id) ?? 0,
      ownedConversations: ownedConversations.get(row.id) ?? 0,
    }))
  }

  /** An instance without administrators can no longer be administered. */
  const assertAnotherAdminRemains = (userId: string): void => {
    const [others] = ctx.db
      .select({ total: count() })
      .from(users)
      .where(and(eq(users.isAdmin, true), ne(users.id, userId)))
      .all()

    if ((others?.total ?? 0) === 0) {
      throw conflict(
        'last_admin',
        'This is the last administrator: the instance would become unmanageable.',
      )
    }
  }

  app.get('/api/users', async (request) => {
    requireAdmin(request)
    return listUsers()
  })

  app.post('/api/users', async (request, reply) => {
    requireAdmin(request)
    const body = createUserBodySchema.parse(request.body)

    const existing = ctx.db.select().from(users).where(eq(users.username, body.username)).get()
    if (existing) {
      throw conflict('username_taken', 'Username {username} is already taken.', {
        username: body.username,
      })
    }

    const id = randomUUID()
    ctx.db
      .insert(users)
      .values({
        id,
        username: body.username,
        passwordHash: await hashPassword(body.password),
        displayName: body.displayName,
        isAdmin: body.isAdmin,
        createdAt: Date.now(),
      })
      .run()
    // Invited users take ownership of their account on first login.
    armOnboarding(ctx.db, id)

    return reply.status(201).send({ ok: true })
  })

  /** Edits an account. One route supports editing one's own account or another account as an administrator. Keeping both writes together avoids duplicate paths that could diverge; the target determines permissions. */
  app.patch('/api/users/:id', async (request) => {
    const actor = requireUser(request)
    const { id } = request.params as { id: string }
    const body = updateUserBodySchema.parse(request.body)

    const isSelf = id === actor.id
    if (!isSelf && !actor.isAdmin) {
      throw forbidden('user_edit_forbidden', 'Only an administrator can modify another account.')
    }

    const target = ctx.db.select().from(users).where(eq(users.id, id)).get()
    if (!target) throw notFound('user_not_found', 'User not found.')

    const patch: Partial<typeof users.$inferInsert> = {}
    if (body.displayName !== undefined) patch.displayName = body.displayName

    if (body.username !== undefined && body.username !== target.username) {
      const taken = ctx.db.select().from(users).where(eq(users.username, body.username)).get()
      if (taken) {
        throw conflict('username_taken', 'Username {username} is already taken.', {
          username: body.username,
        })
      }
      patch.username = body.username
    }

    if (body.isAdmin !== undefined && body.isAdmin !== target.isAdmin) {
      // Self-assignment of roles would make the distinction meaningless.
      if (!actor.isAdmin) {
        throw forbidden('role_change_forbidden', 'Only an administrator can change a role.')
      }
      // Removing one's own administration rights would make this screen inaccessible:
      // that mistake is costly enough to warrant an explicit rejection.
      if (isSelf && !body.isAdmin) {
        throw forbidden(
          'self_demote_forbidden',
          'Remove your own admin role from another administrator account.',
        )
      }
      if (!body.isAdmin) assertAnotherAdminRemains(target.id)
      patch.isAdmin = body.isAdmin
    }

    if (body.password !== undefined) {
      // Changing one's password requires the current password; otherwise an unlocked
      // screen would suffice to take over the account permanently.
      if (isSelf) {
        if (!body.currentPassword) {
          throw badRequest('current_password_required', 'Enter your current password.')
        }
        if (!(await verifyPassword(target.passwordHash, body.currentPassword))) {
          throw forbidden('password_incorrect', 'Current password is incorrect.')
        }
      }
      patch.passwordHash = await hashPassword(body.password)
    }

    if (Object.keys(patch).length === 0) return { ok: true }
    ctx.db.update(users).set(patch).where(eq(users.id, id)).run()

    // Password changes must close other sessions or resetting would regain no control.
    // For one's own account, preserve the current session:
    // logging users out when changing their password would be punishment
    // rather than protection.
    if (patch.passwordHash) {
      const current = request.cookies[SESSION_COOKIE]
      const keep = current ? sessionTokenHash(current) : null
      ctx.db
        .delete(authSessions)
        .where(
          keep && isSelf
            ? and(eq(authSessions.userId, id), ne(authSessions.tokenHash, keep))
            : eq(authSessions.userId, id),
        )
        .run()
    }

    return { ok: true }
  })

  app.delete('/api/users/:id', async (request, reply) => {
    const admin = requireAdmin(request)
    const { id } = request.params as { id: string }

    if (id === admin.id) throw badRequest('self_delete', 'You cannot delete your own account.')

    const target = listUsers().find((entry) => entry.id === id)
    if (!target) throw notFound('user_not_found', 'User not found.')

    // Foreign keys referencing `users` do not cascade: deletion would fail in the
    // database. Explain the restriction rather than let it fail unexpectedly.
    if (target.ownedProjects > 0 || target.ownedConversations > 0) {
      throw conflict(
        'user_owns_resources',
        'User {username} owns {projectCount} project(s) and {conversationCount} conversation(s). Transfer or delete them first.',
        {
          username: target.username,
          projectCount: target.ownedProjects,
          conversationCount: target.ownedConversations,
        },
      )
    }

    if (target.isAdmin) assertAnotherAdminRemains(id)

    ctx.db.delete(users).where(eq(users.id, id)).run()
    return reply.status(204).send()
  })
}
