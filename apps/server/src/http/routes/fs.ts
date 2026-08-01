import { constants, existsSync } from 'node:fs'
import { access, mkdir, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { FastifyInstance } from 'fastify'
import { browseQuerySchema, mkdirBodySchema, type FsEntryDto, type FsListingDto } from '@sillage/protocol'
import { badRequest, conflict, forbidden, notFound } from '../errors.js'
import { requireUser } from '../require-user.js'

/**
 * Un dossier très peuplé ne doit pas produire une réponse de plusieurs mégaoctets
 * ni bloquer l'event loop sur les stat().
 */
const MAX_ENTRIES = 500

/**
 * Dossiers systèmes sans intérêt comme workspace, et dont la traversée est lente ou
 * dangereuse (/proc expose un dossier par processus, /sys des milliers d'entrées).
 */
const DENIED_PREFIXES = ['/proc', '/sys', '/dev', '/run']

function isDenied(path: string): boolean {
  return DENIED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
}

async function describeEntry(parentPath: string, name: string): Promise<FsEntryDto | null> {
  const path = join(parentPath, name)
  try {
    // stat et non lstat : un lien symbolique vers un dossier est un dossier valide ici.
    const info = await stat(path)
    if (!info.isDirectory()) return null
  } catch {
    // Lien cassé ou permission refusée sur la cible : l'entrée n'est pas exploitable.
    return null
  }

  let readable = true
  try {
    // R_OK pour lister, X_OK pour traverser. Un seul appel système, alors qu'un
    // readdir de test lirait entièrement chacun des 500 sous-dossiers.
    await access(path, constants.R_OK | constants.X_OK)
  } catch {
    readable = false
  }

  return { name, path, isGitRepo: existsSync(join(path, '.git')), readable }
}

export function registerFsRoutes(app: FastifyInstance): void {
  const home = homedir()

  app.get('/api/fs/browse', async (request): Promise<FsListingDto> => {
    requireUser(request)
    const query = browseQuerySchema.parse(request.query)

    // resolve() normalise les '..' : la valeur retournée est toujours canonique, ce
    // qui évite qu'un chemin comme /home/x/../../etc s'affiche autrement qu'il n'est.
    const path = resolve(query.path ?? home)

    if (isDenied(path)) {
      throw forbidden('system_directory_denied', 'This system directory cannot be browsed.')
    }

    let info
    try {
      info = await stat(path)
    } catch {
      throw notFound('directory_not_found', 'Directory {path} does not exist.', { path })
    }
    if (!info.isDirectory())
      throw badRequest('not_a_directory', '{path} is not a directory.', { path })

    let names: string[]
    try {
      names = await readdir(path)
    } catch {
      throw forbidden('directory_read_denied', 'Read access to {path} was denied.', { path })
    }

    const visible = names
      .filter((name) => query.showHidden || !name.startsWith('.'))
      .filter((name) => !isDenied(join(path, name)))
      .sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }))

    const truncated = visible.length > MAX_ENTRIES
    const described = await Promise.all(
      visible.slice(0, MAX_ENTRIES).map((name) => describeEntry(path, name)),
    )

    const parent = dirname(path)

    return {
      path,
      parent: parent === path ? null : parent,
      entries: described.filter((entry): entry is FsEntryDto => entry !== null),
      isGitRepo: existsSync(join(path, '.git')),
      truncated,
      roots: [
        { label: 'Accueil', path: home },
        { label: 'Racine', path: '/' },
      ],
    }
  })

  app.post('/api/fs/mkdir', async (request): Promise<FsEntryDto> => {
    requireUser(request)
    const body = mkdirBodySchema.parse(request.body)

    // Un nom qui contient '/' viserait un autre dossier que celui affiché ; '.' et '..'
    // n'ont pas de sens comme nom d'entrée à créer.
    if (body.name.includes('/') || body.name === '.' || body.name === '..') {
      throw badRequest('invalid_name', '{name} is not a valid folder name.', { name: body.name })
    }

    const parent = resolve(body.path)
    if (isDenied(parent)) {
      throw forbidden('system_directory_denied', 'This system directory cannot be browsed.')
    }

    const target = join(parent, body.name)
    if (existsSync(target)) {
      throw conflict('entry_exists', '{name} already exists.', { name: body.name })
    }

    try {
      await mkdir(target)
    } catch (err) {
      throw badRequest('create_failed', 'Could not create {name}: {reason}.', {
        name: body.name,
        reason: err instanceof Error ? err.message : String(err),
      })
    }

    const entry = await describeEntry(parent, body.name)
    if (!entry) {
      throw badRequest('create_failed', 'Could not create {name}: {reason}.', {
        name: body.name,
        reason: 'directory unreadable right after creation',
      })
    }
    return entry
  })
}
