import type { FastifyInstance } from 'fastify'
import {
  createEntryBodySchema,
  deleteEntryBodySchema,
  moveEntryBodySchema,
  treeQuerySchema,
  treeSearchQuerySchema,
  type FileState,
  type TreeListingDto,
  type TreeSearchDto,
} from '@sillage/protocol'
import { readFileStates } from '../../git.js'
import {
  conversationWorkspace,
  createEntry,
  deleteEntry,
  listDirectory,
  moveEntry,
  searchEntries,
} from '../../workspace.js'
import type { AppContext } from '../context.js'
import { requireUser } from '../require-user.js'

/**
 * Priorité d'agrégation sur un dossier : c'est le changement le plus notable de son
 * contenu qui le colore.
 *
 * `ignored` n'y figure pas, et c'est le point : un dossier ignoré à l'intérieur d'un
 * dossier versionné ne dit rien du parent. Le propager remontait `ignored` jusqu'à la
 * racine dès qu'un `node_modules` existait quelque part, et un dossier réellement
 * modifié s'affichait alors en gris au lieu de sa couleur.
 */
const SEVERITY: Record<Exclude<FileState, 'ignored'>, number> = {
  deleted: 1,
  untracked: 2,
  added: 3,
  modified: 4,
}

/**
 * Arborescence du répertoire de travail d'une conversation, un niveau par requête.
 *
 * Les couleurs viennent d'un seul `git status` pour tout le dépôt : un appel par
 * fichier serait ruineux dans un dossier de plusieurs centaines d'entrées. Un dossier
 * porte l'état le plus notable de ce qu'il contient, faute de quoi il faudrait tout
 * déplier pour trouver ce qui a changé.
 */
export function registerTreeRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/conversations/:id/tree', async (request): Promise<TreeListingDto> => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const { path } = treeQuerySchema.parse(request.query)

    const cwd = conversationWorkspace(ctx.db, id, user.id)
    const [entries, states] = await Promise.all([listDirectory(cwd, path), readFileStates(cwd)])

    if (!states) return { path, entries, versioned: false }

    const directoryStates = new Map<string, Exclude<FileState, 'ignored'>>()
    for (const [file, state] of states) {
      if (state === 'ignored') continue

      // Chaque ancêtre du fichier hérite de son état : `apps/web/src/x.ts` colore
      // `apps`, `apps/web` et `apps/web/src`, quel que soit le niveau déplié.
      const parts = file.split('/')
      for (let depth = 1; depth < parts.length; depth += 1) {
        const ancestor = parts.slice(0, depth).join('/')
        const current = directoryStates.get(ancestor)
        if (current === undefined || SEVERITY[state] > SEVERITY[current]) {
          directoryStates.set(ancestor, state)
        }
      }
    }

    return {
      path,
      entries: entries.map((entry) => {
        const state = entry.isDirectory
          ? (states.get(entry.path) ?? directoryStates.get(entry.path))
          : states.get(entry.path)
        return state ? { ...entry, state } : entry
      }),
      versioned: true,
    }
  })

  /**
   * Recherche d'un fichier par son nom, dans tout le répertoire de travail.
   *
   * Séparée de l'arborescence, qui est paginée par niveau : chercher demande de
   * traverser, et traverser à la demande depuis le client ferait une requête par
   * dossier. Aucun état git n'est joint, la liste ne sert qu'à rejoindre un fichier.
   */
  app.get('/api/conversations/:id/tree/search', async (request): Promise<TreeSearchDto> => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const { q } = treeSearchQuerySchema.parse(request.query)

    const cwd = conversationWorkspace(ctx.db, id, user.id)
    return searchEntries(cwd, q)
  })

  /**
   * Manipulations d'entrées.
   *
   * Rien n'est journalisé : un fichier est l'état vivant du disque, pas un événement
   * (l'invariant I2 ne porte que sur la conversation). Ces trois routes ne font que ce
   * que leur nom dit, et le bornage au workspace vit dans `workspace.ts`, avec la
   * résolution de chemin qu'il protège.
   */
  app.post('/api/conversations/:id/entries', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const body = createEntryBodySchema.parse(request.body)

    const cwd = conversationWorkspace(ctx.db, id, user.id)
    const path = await createEntry(cwd, body.parent, body.name, body.kind)
    return reply.status(201).send({ path })
  })

  app.post('/api/conversations/:id/entries/move', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const body = moveEntryBodySchema.parse(request.body)

    const cwd = conversationWorkspace(ctx.db, id, user.id)
    await moveEntry(cwd, body.from, body.to)
    return reply.status(204).send()
  })

  app.delete('/api/conversations/:id/entries', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const body = deleteEntryBodySchema.parse(request.body)

    const cwd = conversationWorkspace(ctx.db, id, user.id)
    await deleteEntry(cwd, body.path)
    return reply.status(204).send()
  })
}
