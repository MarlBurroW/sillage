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
import { resolveInside } from '../../workspace.js'
import { attachmentHeader } from '../attachment-header.js'
import type { AppContext } from '../context.js'
import { HttpError, notFound } from '../errors.js'
import { requireUser } from '../require-user.js'
import { workspaceScopes } from './workspace-scopes.js'

/**
 * Octets inspectés pour décider si un fichier est binaire. Un en-tête suffit : les
 * formats binaires portent presque toujours un octet nul dans leurs premiers octets,
 * et lire le fichier entier pour en juger coûterait ce qu'on cherche à éviter.
 */
const SNIFF_BYTES = 8192

function extensionOf(path: string): string {
  return extname(path).replace('.', '').toLowerCase()
}

/**
 * Empreinte du fichier sur le disque.
 *
 * Taille et date de modification plutôt qu'un hachage du contenu : c'est ce que le
 * système de fichiers donne sans relire le fichier, et deux écritures distinctes ne
 * produisent pas la même paire.
 */
function fingerprint(size: number, mtimeMs: number): string {
  return `${size}:${Math.round(mtimeMs)}`
}

/**
 * Interprète un en-tête `Range` à une seule tranche, `bytes=start-end`, `bytes=start-`
 * ou `bytes=-suffix`. Les formes à plusieurs tranches sont ignorées : le navigateur
 * n'en émet pas pour lire un média, et y répondre demanderait un corps multipart.
 */
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

/**
 * Lecture et écriture des fichiers du workspace, pour l'éditeur du panneau.
 *
 * L'invariant I2 ne s'applique pas : un fichier est l'état vivant du disque, pas un
 * événement. Rien n'est journalisé ici.
 */
export function registerFileRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Deux portées, conversation et projet : voir `workspace-scopes.ts`.
  for (const { base, cwdOf } of workspaceScopes) {
    /** Tout compte qui voit le projet peut lire et écrire, y compris partagé. */
    const workspaceOf = (id: string, userId: string): string => cwdOf(ctx.db, id, userId)

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

    /**
     * Parmi les chemins proposés, ceux qui désignent un fichier de ce workspace.
     *
     * Le fil s'en sert pour ne rendre cliquable que ce qui s'ouvrira vraiment. Une forme
     * de chemin ne prouve rien : `text/plain`, `@sillage/protocol` ou `fs/promises` en
     * ont une, et un lien qui mène à une erreur vaut moins que du texte.
     *
     * `POST` pour une lecture, parce que la liste tient mal dans une URL et qu'elle est
     * la clé du cache côté client.
     */
    app.post(`${base}/files/exist`, async (request) => {
      const user = requireUser(request)
      const { id } = request.params as { id: string }
      const { paths } = filesExistBodySchema.parse(request.body)

      const workspace = workspaceOf(id, user.id)
      const checked = await Promise.all(
        paths.map(async (path) => {
          // `resolveInside` rejette ce qui sort du workspace : un `../` glissé dans un
          // message ne doit pas révéler l'existence d'un fichier au-dehors.
          let absolute
          try {
            absolute = resolveInside(workspace, path)
          } catch {
            return null
          }
          const info = await stat(absolute).catch(() => null)
          return info?.isFile() ? path : null
        }),
      )

      return { files: checked.filter((path): path is string => path !== null) }
    })

    /**
     * Contenu brut, pour afficher une image, un document, un média ou un modèle 3D dans
     * un onglet. Restreint à une liste fermée d'extensions : servir n'importe quel
     * binaire avec un type deviné inviterait le navigateur à l'interpréter.
     *
     * Servi en flux, et par tranches quand le navigateur le demande (`Range`) : c'est
     * ce qui permet de sauter dans une vidéo, et de ne pas charger en mémoire un
     * fichier de plusieurs centaines de Mo.
     */
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

      const absolute = resolveInside(workspaceOf(id, user.id), path)
      const info = await stat(absolute).catch(() => null)
      if (!info?.isFile()) throw notFound('file_not_found', 'File not found.')

      // `Content-Security-Policy` : un SVG est un document, donc capable de porter du
      // script. Servi comme image inerte plutôt que comme page. Un PDF n'y passe pas :
      // c'est la visionneuse du navigateur qui l'affiche, et la même politique la prive
      // de ses propres ressources, donc de tout affichage. `nosniff` reste la garantie
      // que le type annoncé est celui qui sera appliqué.
      if (imageType) {
        reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
      }

      reply
        .header('content-type', type)
        .header('accept-ranges', 'bytes')
        .header('x-content-type-options', 'nosniff')
        // Sans nom, la visionneuse PDF intitule son onglet d'après l'URL de l'API.
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

    /** Tous les formats se téléchargent, sans charger le fichier entier en mémoire. */
    app.get(`${base}/file/download`, async (request, reply) => {
      const user = requireUser(request)
      const { id } = request.params as { id: string }
      const { path } = filePathQuerySchema.parse(request.query)
      const workspace = workspaceOf(id, user.id)
      const candidate = resolveInside(workspace, path)
      const resolved = await Promise.all([realpath(workspace), realpath(candidate)]).catch(() => null)
      if (!resolved) throw notFound('file_not_found', 'File not found.')

      // Vérifier aussi la cible réelle : un lien symbolique ne donne pas accès au dehors.
      const absolute = resolveInside(resolved[0], resolved[1])
      // Un tube nommé doit pouvoir être refusé sans attendre qu'un producteur l'ouvre.
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

      // L'agent écrit dans les mêmes fichiers pendant qu'on les édite. Sans cette
      // comparaison, enregistrer écrase en silence ce qu'il vient de faire, et la perte
      // ne se remarque qu'une heure plus tard. `fingerprint: null` est le choix explicite
      // d'écraser, pris après qu'un conflit a été montré.
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
