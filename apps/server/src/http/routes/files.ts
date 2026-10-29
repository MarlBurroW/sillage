import { constants, createReadStream } from 'node:fs'
import { open, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type { FastifyInstance } from 'fastify'
import {
  MAX_EDITABLE_BYTES,
  VIEWABLE_DOCUMENT_TYPES,
  VIEWABLE_IMAGE_TYPES,
  VIEWABLE_MEDIA_TYPES,
  VIEWABLE_MODEL_TYPES,
  filePathQuerySchema,
  fileWriteBodySchema,
  filesExistBodySchema,
  type FileContentDto,
} from '@sillage/protocol'
import { resolveInside, resolveRealInside } from '../../workspace.js'
import { readableConversation } from '../../conversations/access.js'
import { linkedWorktreePaths } from '../../worktrees/linked.js'
import { attachmentHeader } from '../attachment-header.js'
import type { AppContext } from '../context.js'
import { HttpError, notFound } from '../errors.js'
import { requireUser } from '../require-user.js'
import { workspaceScopes } from './workspace-scopes.js'

/** Bytes inspected to detect binary files. Headers suffice: binary formats nearly always contain null bytes near the start, and reading entire files would incur the very cost this avoids. */
const SNIFF_BYTES = 8192

function extensionOf(path: string): string {
  return extname(path).replace('.', '').toLowerCase()
}

/** Disk file fingerprint. Size and modification time avoid hashing content: the filesystem supplies both without rereading the file, and distinct writes produce different pairs. */
function fingerprint(size: number, mtimeMs: number): string {
  return `${size}:${Math.round(mtimeMs)}`
}

/** Parses single-range `Range` headers: `bytes=start-end`, `bytes=start-` or `bytes=-suffix`. Ignore multiple ranges: browsers do not use them for media playback, and supporting them requires multipart bodies. */
function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header) return null
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || (match[1] === '' && match[2] === '')) return null
  let start: number
  let end: number
  if (match[1] === '') {
    const suffix = Number(match[2])
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)
  }
  if (start >= size || start > end) return 'unsatisfiable'
  return { start, end }
}

/** Workspace file reads and writes for the panel editor. Invariant I2 does not apply: files are live disk state rather than events. Nothing here is journaled. */
export function registerFileRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Conversation and project scopes: see `workspace-scopes.ts`.
  for (const { base, cwdOf } of workspaceScopes) {
    /** Any project viewer can read and write, including shared projects. */
    const workspaceOf = (id: string, userId: string): string => cwdOf(ctx.db, id, userId)

    // A worktree created during a turn is linked without changing the CLI's resume cwd.
    // Only image reads use this fallback; editor writes retain their workspace boundary.
    const imagePath = async (id: string, userId: string, path: string): Promise<string> => {
      const root = workspaceOf(id, userId)
      const existing = async (directory: string): Promise<string | null> => {
        try {
          const absolute = await resolveRealInside(directory, path)
          return (await stat(absolute)).isFile() ? absolute : null
        } catch {
          return null
        }
      }
      const primary = await existing(root)
      if (primary) return primary
      if (base === '/api/conversations/:id') {
        const conversation = readableConversation(ctx.db, id, userId)
        if (conversation.projectId) {
          const roots = linkedWorktreePaths(ctx.db, id, conversation.projectId)
          const matches = [...new Set((await Promise.all(roots.map(existing))).filter((entry) => entry !== null))]
          // Relative paths shared by multiple linked trees are ambiguous: require an absolute path.
          if (matches.length === 1) return matches[0]!
        }
      }
      throw notFound('file_not_found', 'File not found.')
    }

    app.get(`${base}/file`, async (request): Promise<FileContentDto> => {
      const user = requireUser(request)
      const { id } = request.params as { id: string }
      const { path } = filePathQuerySchema.parse(request.query)

      const absolute = resolveInside(workspaceOf(id, user.id), path)

      const info = await stat(absolute).catch(() => null)
      if (!info?.isFile()) throw new HttpError(404, 'not_a_file', 'This path is not a file.')
      if (info.size > MAX_EDITABLE_BYTES) {
        throw new HttpError(
          413,
          'too_large',
          'File is {sizeKb} KB, above the {maxKb} KB limit, and will not be opened.',
          {
            sizeKb: Math.round(info.size / 1024),
            maxKb: Math.round(MAX_EDITABLE_BYTES / 1024),
          },
        )
      }

      const buffer = await readFile(absolute)
      if (buffer.subarray(0, SNIFF_BYTES).includes(0)) {
        throw new HttpError(415, 'binary', 'Binary file, not editable as text.')
      }

      return {
        path,
        content: buffer.toString('utf8'),
        fingerprint: fingerprint(info.size, info.mtimeMs),
        extension: extensionOf(path),
      }
    })

    /** Filters candidate paths to actual workspace files. Conversations use this to make only working links clickable. Path-like syntax proves nothing: `text/plain`, `@sillage/protocol` and `fs/promises` all resemble paths, and broken links are worse than text. Uses `POST` for reads because lists fit poorly in URLs and form the client cache key. */
    app.post(`${base}/files/exist`, async (request) => {
      const user = requireUser(request)
      const { id } = request.params as { id: string }
      const { paths } = filesExistBodySchema.parse(request.body)

      const workspace = workspaceOf(id, user.id)
      const checked = await Promise.all(
        paths.map(async (path) => {
          // `resolveInside` rejects paths outside the workspace: `../` inside messages must
          // not reveal whether external files exist.
          let absolute
          try {
            absolute = VIEWABLE_IMAGE_TYPES[extensionOf(path)]
              ? await imagePath(id, user.id, path)
              : resolveInside(workspace, path)
          } catch {
            return null
          }
          const info = await stat(absolute).catch(() => null)
          return info?.isFile() ? path : null
        }),
      )

      return { files: checked.filter((path): path is string => path !== null) }
    })

    /** Raw content for displaying images, documents, media and 3D models in tabs. Restricted to an extension allowlist: serving arbitrary binaries with guessed types would invite browser interpretation. Streams content and supports browser-requested `Range` slices to enable seeking and avoid loading hundred-megabyte files into memory. */
    app.get(`${base}/file/raw`, async (request, reply) => {
      const user = requireUser(request)
      const { id } = request.params as { id: string }
      const { path } = filePathQuerySchema.parse(request.query)

      const extension = extensionOf(path)
      const imageType = VIEWABLE_IMAGE_TYPES[extension]
      const type = imageType
        ?? VIEWABLE_DOCUMENT_TYPES[extension]
        ?? VIEWABLE_MEDIA_TYPES[extension]
        ?? VIEWABLE_MODEL_TYPES[extension]
      if (!type) throw new HttpError(415, 'not_viewable', 'This file type cannot be displayed.')

      const absolute = imageType
        ? await imagePath(id, user.id, path)
        : resolveInside(workspaceOf(id, user.id), path)
      const info = await stat(absolute).catch(() => null)
      if (!info?.isFile()) throw notFound('file_not_found', 'File not found.')

      // Content-Security-Policy: SVG is a document capable of carrying
      // scripts. Serve SVG as inert images rather than pages. Exclude PDFs:
      // the browser viewer renders them, and this policy would block its own resources,
      // preventing display. `nosniff` still guarantees
      // that browsers apply the declared type.
      if (imageType) {
        reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
      }

      reply
        .header('content-type', type)
        .header('accept-ranges', 'bytes')
        .header('x-content-type-options', 'nosniff')
        // Without a filename, the PDF viewer titles its tab after the API URL.
        .header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(basename(path))}`)
        .header('cache-control', 'no-store')

      const range = parseRange(request.headers.range, info.size)
      if (range === 'unsatisfiable') {
        return reply.code(416).header('content-range', `bytes */${info.size}`).send()
      }
      if (range) {
        return reply
          .code(206)
          .header('content-range', `bytes ${range.start}-${range.end}/${info.size}`)
          .header('content-length', range.end - range.start + 1)
          .send(createReadStream(absolute, { start: range.start, end: range.end }))
      }
      return reply.header('content-length', info.size).send(createReadStream(absolute))
    })

    /** All formats can be downloaded without loading entire files into memory. */
    app.get(`${base}/file/download`, async (request, reply) => {
      const user = requireUser(request)
      const { id } = request.params as { id: string }
      const { path } = filePathQuerySchema.parse(request.query)
      const workspace = workspaceOf(id, user.id)
      const candidate = resolveInside(workspace, path)
      const resolved = await Promise.all([realpath(workspace), realpath(candidate)]).catch(() => null)
      if (!resolved) throw notFound('file_not_found', 'File not found.')

      // Check real targets too: symlinks must not grant access outside the workspace.
      const absolute = resolveInside(resolved[0], resolved[1])
      // Named pipes must be rejectable without waiting for a writer to open them.
      const file = await open(absolute, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW).catch(() => null)
      if (!file) throw notFound('file_not_found', 'File not found.')
      const info = await file.stat().catch(() => null)
      if (!info?.isFile()) {
        await file.close()
        throw notFound('file_not_found', 'File not found.')
      }

      return reply
        .header('content-type', 'application/octet-stream')
        .header('content-disposition', attachmentHeader(basename(path)))
        .header('content-length', info.size)
        .header('x-content-type-options', 'nosniff')
        .header('cache-control', 'no-store')
        .send(file.createReadStream())
    })

    app.put(`${base}/file`, async (request) => {
      const user = requireUser(request)
      const { id } = request.params as { id: string }
      const body = fileWriteBodySchema.parse(request.body)

      const absolute = resolveInside(workspaceOf(id, user.id), body.path)

      const info = await stat(absolute).catch(() => null)
      if (info && !info.isFile()) {
        throw new HttpError(400, 'not_a_file', 'This path is not a file.')
      }

      // Agents write the same files while users edit them. Without this comparison,
      // saving silently overwrites their latest changes, with losses noticed much later.
      // `fingerprint: null` explicitly chooses overwriting
      // after a conflict has been displayed.
      if (body.fingerprint !== null) {
        const current = info ? fingerprint(info.size, info.mtimeMs) : null
        if (current !== body.fingerprint) {
          throw new HttpError(
            409,
            'stale_write',
            'The file changed on disk since it was opened.',
          )
        }
      }

      await writeFile(absolute, body.content, 'utf8')
      const written = await stat(absolute)
      return { fingerprint: fingerprint(written.size, written.mtimeMs) }
    })
  }
}
