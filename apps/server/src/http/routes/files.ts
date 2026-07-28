import { readFile, stat, writeFile } from 'node:fs/promises'
import { extname } from 'node:path'
import type { FastifyInstance } from 'fastify'
import {
  MAX_EDITABLE_BYTES,
  VIEWABLE_IMAGE_TYPES,
  filePathQuerySchema,
  fileWriteBodySchema,
  filesExistBodySchema,
  type FileContentDto,
} from '@sillage/protocol'
import { conversationWorkspace, resolveInside } from '../../workspace.js'
import type { AppContext } from '../context.js'
import { HttpError, notFound } from '../errors.js'
import { requireUser } from '../require-user.js'

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
 * Lecture et écriture des fichiers du workspace, pour l'éditeur du panneau.
 *
 * L'invariant I2 ne s'applique pas : un fichier est l'état vivant du disque, pas un
 * événement. Rien n'est journalisé ici.
 */
export function registerFileRoutes(app: FastifyInstance, ctx: AppContext): void {
  /** Tout compte qui voit le projet peut lire et écrire, y compris partagé. */
  const workspaceOf = (conversationId: string, userId: string): string =>
    conversationWorkspace(ctx.db, conversationId, userId)

  app.get('/api/conversations/:id/file', async (request): Promise<FileContentDto> => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const { path } = filePathQuerySchema.parse(request.query)

    const absolute = resolveInside(workspaceOf(id, user.id), path)

    const info = await stat(absolute).catch(() => null)
    if (!info?.isFile()) throw new HttpError(404, 'not_a_file', 'Ce chemin n\'est pas un fichier.')
    if (info.size > MAX_EDITABLE_BYTES) {
      throw new HttpError(
        413,
        'too_large',
        `Fichier de ${Math.round(info.size / 1024)} Ko : au-delà de ${Math.round(
          MAX_EDITABLE_BYTES / 1024,
        )} Ko, il n'est pas ouvert.`,
      )
    }

    const buffer = await readFile(absolute)
    if (buffer.subarray(0, SNIFF_BYTES).includes(0)) {
      throw new HttpError(415, 'binary', 'Fichier binaire, non éditable comme du texte.')
    }

    return {
      path,
      content: buffer.toString('utf8'),
      fingerprint: fingerprint(info.size, info.mtimeMs),
      extension: extensionOf(path),
    }
  })

  /**
   * Contenu brut, pour afficher une image dans un onglet. Restreint à une liste fermée
   * d'extensions : servir n'importe quel binaire avec un type deviné inviterait le
   * navigateur à l'interpréter.
   */
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
  app.post('/api/conversations/:id/files/exist', async (request) => {
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

  app.get('/api/conversations/:id/file/raw', async (request, reply) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const { path } = filePathQuerySchema.parse(request.query)

    const extension = extensionOf(path)
    const type = VIEWABLE_IMAGE_TYPES[extension]
    if (!type) throw new HttpError(415, 'not_viewable', 'Ce type de fichier ne s\'affiche pas.')

    const absolute = resolveInside(workspaceOf(id, user.id), path)
    const info = await stat(absolute).catch(() => null)
    if (!info?.isFile()) throw notFound('Fichier introuvable.')

    // `Content-Security-Policy` : un SVG est un document, donc capable de porter du
    // script. Servi comme image inerte plutôt que comme page.
    return reply
      .header('content-type', type)
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
      .header('cache-control', 'no-store')
      .send(await readFile(absolute))
  })

  app.put('/api/conversations/:id/file', async (request) => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const body = fileWriteBodySchema.parse(request.body)

    const absolute = resolveInside(workspaceOf(id, user.id), body.path)

    const info = await stat(absolute).catch(() => null)
    if (info && !info.isFile()) {
      throw new HttpError(400, 'not_a_file', 'Ce chemin n\'est pas un fichier.')
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
          'Le fichier a changé sur le disque depuis son ouverture.',
        )
      }
    }

    await writeFile(absolute, body.content, 'utf8')
    const written = await stat(absolute)
    return { fingerprint: fingerprint(written.size, written.mtimeMs) }
  })
}
