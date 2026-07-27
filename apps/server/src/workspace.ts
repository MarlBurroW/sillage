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

  if (!row) throw notFound('Conversation introuvable.')
  if (row.ownerId !== userId && row.visibility !== 'shared') {
    throw notFound('Conversation introuvable.')
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
  if (!project) throw notFound('Projet introuvable.')
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
      `« ${relativePath} » sort du répertoire de travail.`,
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
    throw new HttpError(400, 'git_internals', 'Le dossier .git ne se manipule pas ici.')
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
    throw new HttpError(409, 'entry_exists', `« ${name} » existe déjà.`)
  }

  try {
    if (kind === 'directory') await mkdir(absolute, { recursive: true })
    // `wx` échoue si le fichier apparaît entre la vérification et l'écriture : le
    // contrôle ci-dessus renseigne, celui-ci décide.
    else await writeFile(absolute, '', { flag: 'wx' })
  } catch (err) {
    throw new HttpError(400, 'create_failed', err instanceof Error ? err.message : String(err))
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
    throw new HttpError(400, 'move_into_self', 'Un dossier ne peut pas être déplacé dans lui-même.')
  }
  if (await exists(destination)) {
    throw new HttpError(409, 'entry_exists', `« ${to} » existe déjà.`)
  }

  try {
    await mkdir(dirname(destination), { recursive: true })
    await rename(source, destination)
  } catch (err) {
    throw new HttpError(400, 'move_failed', err instanceof Error ? err.message : String(err))
  }
}

/** Supprime une entrée, dossier compris avec son contenu. */
export async function deleteEntry(root: string, relativePath: string): Promise<void> {
  refuseGitInternals(relativePath)

  const absolute = resolveInside(root, relativePath)
  if (absolute === resolve(root)) {
    throw new HttpError(400, 'delete_root', 'Le répertoire de travail ne se supprime pas.')
  }
  if (!(await exists(absolute))) throw notFound('Entrée introuvable.')

  try {
    await rm(absolute, { recursive: true, force: true })
  } catch (err) {
    throw new HttpError(400, 'delete_failed', err instanceof Error ? err.message : String(err))
  }
}

/**
 * Un niveau de l'arborescence, dossiers d'abord puis fichiers, chacun trié par nom.
 *
 * Les liens symboliques ne sont pas suivis (`withFileTypes` renvoie leur propre type) :
 * un lien vers la racine ferait boucler l'explorateur, et le suivre contournerait le
 * bornage au workspace.
 */
export async function listDirectory(root: string, relativePath: string): Promise<TreeEntryDto[]> {
  const absolute = resolveInside(root, relativePath)

  let entries
  try {
    entries = await readdir(absolute, { withFileTypes: true })
  } catch (err) {
    throw new HttpError(
      404,
      'directory_unreadable',
      `Dossier illisible : ${err instanceof Error ? err.message : String(err)}`,
    )
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
