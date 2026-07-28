import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path'
import { eq } from 'drizzle-orm'
import { conversations, projects, worktrees, type ConversationRow, type Db } from '@sillage/db'
import type { TreeEntryDto } from '@sillage/protocol'
import { HttpError, notFound } from './http/errors.js'

/**
 * Répertoire de travail d'une conversation, et bornage des chemins qui s'y rapportent.
 *
 * Extrait du gestionnaire de sessions parce que le panneau latéral en a besoin sans
 * qu'aucune session ne tourne : lire l'arborescence ne demande pas d'agent démarré.
 */

/** Un niveau par requête : un `node_modules` déplié d'un coup pèse des mégaoctets. */
const MAX_ENTRIES = 1000

/**
 * Répertoire de travail d'une conversation que ce compte a le droit de voir.
 *
 * Le contrôle de visibilité est ici, avec la résolution du chemin, plutôt que recopié
 * dans chaque route du panneau : trois copies, c'est trois endroits où l'oublier.
 * Un accès refusé répond « introuvable », comme le reste de l'API : distinguer les
 * deux dirait à un tiers qu'une conversation existe.
 */
export function conversationWorkspace(db: Db, conversationId: string, userId: string): string {
  const row = db
    .select({
      conversation: conversations,
      ownerId: projects.ownerId,
      visibility: projects.visibility,
    })
    .from(conversations)
    .innerJoin(projects, eq(projects.id, conversations.projectId))
    .where(eq(conversations.id, conversationId))
    .get()

  if (!row) throw notFound('conversation_not_found', 'Conversation not found.')
  if (row.ownerId !== userId && row.visibility !== 'shared') {
    throw notFound('conversation_not_found', 'Conversation not found.')
  }
  return resolveConversationCwd(db, row.conversation)
}

export function resolveConversationCwd(db: Db, conversation: ConversationRow): string {
  if (conversation.worktreeId) {
    const worktree = db
      .select()
      .from(worktrees)
      .where(eq(worktrees.id, conversation.worktreeId))
      .get()
    if (worktree && !worktree.removedAt) return worktree.path
  }

  const project = db.select().from(projects).where(eq(projects.id, conversation.projectId)).get()
  if (!project) throw notFound('project_not_found', 'Project not found.')
  return project.workspacePath
}

/**
 * Chemin absolu d'une entrée du workspace, refusé s'il en sort.
 *
 * Sans ce bornage, un `..` dans un chemin donnerait à quiconque a accès à un projet
 * partagé un navigateur de fichiers sur toute la machine.
 */
export function resolveInside(root: string, relativePath: string): string {
  const absolute = resolve(root, relativePath)
  const inside = relative(root, absolute)
  if (inside.startsWith('..') || isAbsolute(inside)) {
    throw new HttpError(
      400,
      'path_outside_workspace',
      'Path {path} is outside the working directory.',
      { path: relativePath },
    )
  }
  return absolute
}

/** Comme `resolveInside`, mais renvoie aussi le nom, pour les mentions `@`. */
export function resolveMention(
  root: string,
  relativePath: string,
): { relativePath: string; path: string; name: string } {
  const path = resolveInside(root, relativePath)
  return { relativePath, path, name: basename(path) }
}

/**
 * Refuse tout chemin qui traverse `.git`.
 *
 * L'explorateur masque déjà ce dossier, mais l'interface n'est pas le garde-fou :
 * renommer ou supprimer le stockage de git par une requête directe détruirait
 * l'historique du dépôt, sans que rien ne soit récupérable.
 */
function refuseGitInternals(relativePath: string): void {
  if (relativePath.split('/').includes('.git')) {
    throw new HttpError(400, 'git_internals', 'The .git folder cannot be manipulated here.')
  }
}

async function exists(absolute: string): Promise<boolean> {
  return stat(absolute).then(
    () => true,
    () => false,
  )
}

/** Crée un fichier vide ou un dossier. Refuse d'écraser ce qui est déjà là. */
export async function createEntry(
  root: string,
  parent: string,
  name: string,
  kind: 'file' | 'directory',
): Promise<string> {
  const relativePath = parent ? `${parent}/${name}` : name
  refuseGitInternals(relativePath)

  const absolute = resolveInside(root, relativePath)
  if (await exists(absolute)) {
    throw new HttpError(409, 'entry_exists', '{name} already exists.', { name })
  }

  try {
    if (kind === 'directory') await mkdir(absolute, { recursive: true })
    // `wx` échoue si le fichier apparaît entre la vérification et l'écriture : le
    // contrôle ci-dessus renseigne, celui-ci décide.
    else await writeFile(absolute, '', { flag: 'wx' })
  } catch (err) {
    throw new HttpError(400, 'create_failed', 'Could not create {name}: {reason}.', {
      name,
      reason: err instanceof Error ? err.message : String(err),
    })
  }

  return relativePath
}

/**
 * Renomme ou déplace une entrée : c'est la même opération, seul le chemin change.
 *
 * Le dossier de destination est créé au besoin, pour qu'un déplacement vers un chemin
 * profond ne demande pas de le préparer d'abord.
 */
export async function moveEntry(root: string, from: string, to: string): Promise<void> {
  refuseGitInternals(from)
  refuseGitInternals(to)

  const source = resolveInside(root, from)
  const destination = resolveInside(root, to)
  if (source === destination) return

  // Déplacer un dossier dans lui-même détruirait son contenu : `rename` le refuse sur
  // certains systèmes et l'accepte sur d'autres, donc on tranche ici.
  if (destination.startsWith(`${source}/`)) {
    throw new HttpError(400, 'move_into_self', 'A folder cannot be moved into itself.')
  }
  if (await exists(destination)) {
    throw new HttpError(409, 'entry_exists', '{name} already exists.', { name: to })
  }

  try {
    await mkdir(dirname(destination), { recursive: true })
    await rename(source, destination)
  } catch (err) {
    throw new HttpError(400, 'move_failed', 'Could not move {from} to {to}: {reason}.', {
      from,
      to,
      reason: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Supprime une entrée, dossier compris avec son contenu. */
export async function deleteEntry(root: string, relativePath: string): Promise<void> {
  refuseGitInternals(relativePath)

  const absolute = resolveInside(root, relativePath)
  if (absolute === resolve(root)) {
    throw new HttpError(400, 'delete_root', 'The working directory cannot be deleted.')
  }
  if (!(await exists(absolute))) throw notFound('entry_not_found', 'Entry not found.')

  try {
    await rm(absolute, { recursive: true, force: true })
  } catch (err) {
    throw new HttpError(400, 'delete_failed', 'Could not delete {path}: {reason}.', {
      path: relativePath,
      reason: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Un niveau de l'arborescence, dossiers d'abord puis fichiers, chacun trié par nom.
 *
 * Les liens symboliques ne sont pas suivis (`withFileTypes` renvoie leur propre type) :
 * un lien vers la racine ferait boucler l'explorateur, et le suivre contournerait le
 * bornage au workspace.
 */
/**
 * Dossiers écartés de la recherche.
 *
 * Ils ne sont pas cachés de l'explorateur, où les déplier est un choix ; les traverser
 * pour trouver un fichier est autre chose : `node_modules` seul pèse plus que tout le
 * reste du dépôt réuni, et ses résultats ne sont jamais ceux qu'on cherche.
 */
const SEARCH_SKIP = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  '.next',
  '.nuxt',
  '.venv',
  '__pycache__',
  '.pnpm-store',
  'coverage',
])

/** Au-delà, la liste ne se lit plus et la marche coûte plus qu'elle ne rapporte. */
const SEARCH_MAX_RESULTS = 80
const SEARCH_MAX_VISITED = 30_000

/**
 * Recherche un fichier par son nom dans tout le répertoire de travail.
 *
 * Sous-chaîne insensible à la casse et aux accents, pas de correspondance floue : sur
 * une arborescence de projet, le flou remonte surtout du bruit, et on tape presque
 * toujours un morceau exact du nom. Les correspondances sur le nom passent avant celles
 * sur le chemin, et les plus courtes avant les plus longues, parce que `panel.ts` est
 * plus probablement la cible que `panel-transition-helpers.ts`.
 *
 * La marche est bornée en largeur comme en profondeur d'exploration : un répertoire de
 * travail peut être n'importe quoi, y compris un point de montage réseau.
 */
export async function searchEntries(
  root: string,
  query: string,
): Promise<{ entries: TreeEntryDto[]; truncated: boolean }> {
  const needle = fold(query)
  const found: TreeEntryDto[] = []
  const queue: string[] = ['']
  let visited = 0
  let truncated = false

  while (queue.length > 0) {
    const relative = queue.shift() as string

    let entries
    try {
      entries = await readdir(resolveInside(root, relative), { withFileTypes: true })
    } catch {
      // Un dossier illisible (droits, lien cassé) n'interrompt pas la recherche : il
      // n'est simplement pas exploré.
      continue
    }

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isFile()) continue

      visited += 1
      if (visited > SEARCH_MAX_VISITED) {
        truncated = true
        return { entries: rank(found, needle), truncated }
      }

      const path = relative ? `${relative}/${entry.name}` : entry.name

      if (entry.isDirectory()) {
        if (!SEARCH_SKIP.has(entry.name)) queue.push(path)
        continue
      }

      if (!fold(path).includes(needle)) continue

      found.push({ name: entry.name, path, isDirectory: false })
      if (found.length >= SEARCH_MAX_RESULTS) {
        truncated = true
        return { entries: rank(found, needle), truncated }
      }
    }
  }

  return { entries: rank(found, needle), truncated }
}

/** Casse et accents retirés : chercher « recu » doit trouver « reçu ». */
function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
}

function rank(entries: TreeEntryDto[], needle: string): TreeEntryDto[] {
  return entries.sort((a, b) => {
    const inNameA = fold(a.name).includes(needle)
    const inNameB = fold(b.name).includes(needle)
    if (inNameA !== inNameB) return inNameA ? -1 : 1
    if (a.path.length !== b.path.length) return a.path.length - b.path.length
    return a.path.localeCompare(b.path, 'fr')
  })
}

export async function listDirectory(root: string, relativePath: string): Promise<TreeEntryDto[]> {
  const absolute = resolveInside(root, relativePath)

  let entries
  try {
    entries = await readdir(absolute, { withFileTypes: true })
  } catch (err) {
    throw new HttpError(404, 'directory_unreadable', 'Directory {path} is unreadable: {reason}.', {
      path: relativePath,
      reason: err instanceof Error ? err.message : String(err),
    })
  }

  const listed: TreeEntryDto[] = entries
    // `.git` est le stockage de git, pas du contenu de projet : l'ouvrir n'a aucun
    // sens et il porterait le plus gros sous-arbre de la racine. Les autres fichiers
    // cachés restent visibles, `.gitignore` étant du contenu comme un autre.
    .filter((entry) => entry.name !== '.git')
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .slice(0, MAX_ENTRIES)
    .map((entry) => ({
      name: entry.name,
      path: relativePath ? `${relativePath}/${entry.name}` : entry.name,
      isDirectory: entry.isDirectory(),
    }))

  return listed.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name, 'fr')
  })
}
