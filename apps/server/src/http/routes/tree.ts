import type { FastifyInstance } from 'fastify'
import {
  MAX_UPLOAD_BYTES,
  archiveQuerySchema,
  copyEntryBodySchema,
  createEntryBodySchema,
  deleteEntryBodySchema,
  moveEntryBodySchema,
  treeQuerySchema,
  treeSearchQuerySchema,
  uploadQuerySchema,
  type FileState,
  type TreeListingDto,
  type TreeSearchDto,
} from '@sillage/protocol'
import { readFileStates } from '../../git.js'
import {
  copyEntry,
  createEntry,
  deleteEntry,
  listDirectory,
  moveEntry,
  searchEntries,
  writeUpload,
} from '../../workspace.js'
import { collectArchive, streamArchive } from '../../workspace-archive.js'
import { attachmentHeader } from '../attachment-header.js'
import type { AppContext } from '../context.js'
import { badRequest } from '../errors.js'
import { requireUser } from '../require-user.js'
import { workspaceScopes } from './workspace-scopes.js'

/**
 * Folder aggregation priority: its most significant child change sets its color.
 *
 * Deliberately excludes `ignored`: an ignored child says nothing about its tracked
 * parent. Propagating it marked everything up to the root as ignored whenever
 * `node_modules` existed, making genuinely modified folders appear gray.
 */
const SEVERITY: Record<Exclude<FileState, 'ignored'>, number> = {
  deleted: 1,
  untracked: 2,
  added: 3,
  modified: 4,
}

/**
 * Conversation working-directory tree, one level per request.
 *
 * Colors come from one repository-wide `git status`: per-file calls would be
 * prohibitively expensive in large directories. Folders inherit their most
 * significant child status so finding changes does not require expanding everything.
 */
export function registerTreeRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Conversation and project scopes: see `workspace-scopes.ts`.
  for (const { base, cwdOf } of workspaceScopes) {
    app.get(`${base}/tree`, async (request): Promise<TreeListingDto> => {
      const user = requireUser(request)
      const { id } = request.params as { id: string }
      const { path } = treeQuerySchema.parse(request.query)

      const cwd = cwdOf(ctx.db, id, user.id)
      const [entries, states] = await Promise.all([listDirectory(cwd, path), readFileStates(cwd)])

      if (!states) return { path, entries, versioned: false, root: cwd }

      const directoryStates = new Map<string, Exclude<FileState, 'ignored'>>()
      for (const [file, state] of states) {
        if (state === 'ignored') continue

        // Each ancestor inherits the file status: `apps/web/src/x.ts` colors `apps`,
        // `apps/web` and `apps/web/src`, regardless of which level is expanded.
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
        root: cwd,
      }
    })

    /**
     * Searches filenames throughout the working directory.
     *
     * Separate from the level-paginated tree: searching needs traversal, and
     * client-driven traversal would require one request per directory. Excludes
     * git status because results only serve to navigate to files.
     */
    app.get(`${base}/tree/search`, async (request): Promise<TreeSearchDto> => {
      const user = requireUser(request)
      const { id } = request.params as { id: string }
      const { q } = treeSearchQuerySchema.parse(request.query)

      const cwd = cwdOf(ctx.db, id, user.id)
      return searchEntries(cwd, q)
    })

    /**
     * Entry operations.
     *
     * Nothing is journaled: files are live disk state, not events (invariant I2
     * applies only to conversations). These three routes do exactly their named
     * operation; workspace boundaries live in `workspace.ts` alongside the path
     * resolution they protect.
     */
    app.post(`${base}/entries`, async (request, reply) => {
      const user = requireUser(request)
      const { id } = request.params as { id: string }
      const body = createEntryBodySchema.parse(request.body)

      const cwd = cwdOf(ctx.db, id, user.id)
      const path = await createEntry(cwd, body.parent, body.name, body.kind)
      return reply.status(201).send({ path })
    })

    /**
     * Explorer file upload.
     *
     * One file per request; destination goes in the URL rather than a form field.
     * Multipart fields arrive in stream order, so reading the destination before
     * content would rely on ordering browsers do not guarantee. Splitting by file
     * also provides reliable UI progress and isolates rejected files from others.
     */
    app.post(`${base}/entries/upload`, async (request, reply) => {
      const user = requireUser(request)
      const { id } = request.params as { id: string }
      const { path } = uploadQuerySchema.parse(request.query)

      const cwd = cwdOf(ctx.db, id, user.id)

      // The plugin limit applies to attachments; files placed on workspace disk
      // have their own, higher limit.
      const part = await request.file({ limits: { fileSize: MAX_UPLOAD_BYTES } })
      if (!part) throw badRequest('no_file', 'No file received.')

      // `truncated` becomes readable only after consuming the stream: the writer checks
      // it afterward to distinguish size overflows from disk failures.
      await writeUpload(cwd, path, part.file, () => part.file.truncated)
      return reply.status(201).send({ path })
    })

    app.post(`${base}/entries/move`, async (request, reply) => {
      const user = requireUser(request)
      const { id } = request.params as { id: string }
      const body = moveEntryBodySchema.parse(request.body)

      const cwd = cwdOf(ctx.db, id, user.id)
      await moveEntry(cwd, body.from, body.to)
      return reply.status(204).send()
    })

    /** Copy and duplicate: the server chooses the name; see copyEntry. */
    app.post(`${base}/entries/copy`, async (request, reply) => {
      const user = requireUser(request)
      const { id } = request.params as { id: string }
      const body = copyEntryBodySchema.parse(request.body)

      const cwd = cwdOf(ctx.db, id, user.id)
      const path = await copyEntry(cwd, body.from, body.toParent)
      return reply.status(201).send({ path })
    })

    /**
     * Streams an explorer selection as `.zip`.
     *
     * Inventory precedes the response so excessive sizes and rejected paths return
     * errors rather than downloads cut off halfway through.
     */
    app.get(`${base}/entries/archive`, async (request, reply) => {
      const user = requireUser(request)
      const { id } = request.params as { id: string }
      const { path } = archiveQuerySchema.parse(request.query)

      const cwd = cwdOf(ctx.db, id, user.id)
      const archive = await collectArchive(cwd, path)
      return reply
        .header('content-type', 'application/zip')
        .header('content-disposition', attachmentHeader(archive.filename))
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'no-store')
        .send(streamArchive(archive.items))
    })

    app.delete(`${base}/entries`, async (request, reply) => {
      const user = requireUser(request)
      const { id } = request.params as { id: string }
      const body = deleteEntryBodySchema.parse(request.body)

      const cwd = cwdOf(ctx.db, id, user.id)
      await deleteEntry(cwd, body.path)
      return reply.status(204).send()
    })
  }
}
