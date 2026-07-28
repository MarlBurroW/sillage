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

/**
 * Administration des comptes.
 *
 * Sillage fonctionne en cercle de confiance : un administrateur peut créer et
 * supprimer des comptes, mais tous les agents tournent sous le même utilisateur
 * système. Cet écran gère l'accès à l'instance, pas des privilèges d'exécution.
 */
export function registerUserRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Comptages groupés : une requête par ressource, pas trois par utilisateur. */
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

  /** Une instance sans administrateur n'est plus administrable par personne. */
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

    ctx.db
      .insert(users)
      .values({
        id: randomUUID(),
        username: body.username,
        passwordHash: await hashPassword(body.password),
        displayName: body.displayName,
        isAdmin: body.isAdmin,
        createdAt: Date.now(),
      })
      .run()

    return reply.status(201).send({ ok: true })
  })

  /**
   * Modification d'un compte.
   *
   * Deux usages dans une seule route : son propre compte, ou celui d'un autre quand on
   * est administrateur. Les séparer donnerait deux chemins à garder cohérents pour la
   * même écriture ; c'est ici la cible qui décide de ce qui est permis.
   */
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
      // Se donner le rôle soi-même viderait la distinction de tout sens.
      if (!actor.isAdmin) {
        throw forbidden('role_change_forbidden', 'Only an administrator can change a role.')
      }
      // Se retirer soi-même le droit d'administrer donne un écran qu'on ne peut plus
      // rouvrir : c'est une erreur assez coûteuse pour valoir un refus explicite.
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
      // Changer son propre mot de passe exige le mot de passe courant : sans ça, un
      // écran resté déverrouillé suffit à prendre le compte définitivement.
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

    // Un mot de passe changé doit fermer les sessions ouvertes ailleurs, sinon la
    // réinitialisation ne reprend le contrôle de rien. Pour son propre compte, la
    // session courante survit : se déconnecter soi-même en changeant son mot de passe
    // serait une punition, pas une protection.
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

    // Les clés étrangères vers `users` ne sont pas en cascade : la suppression
    // échouerait au niveau de la base. On l'explique au lieu de la laisser planter.
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
