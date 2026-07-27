import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { FileState } from '@sillage/protocol'

const run = promisify(execFile)

const GIT_TIMEOUT_MS = 5000

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await run('git', args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  })
  return stdout
}

export interface GitStatus {
  branch: string
  isDirty: boolean
}

/**
 * Retourne null si le chemin n'est pas un dépôt git, ce qui est un cas normal :
 * un projet peut pointer sur un dossier quelconque.
 */
export async function readGitStatus(cwd: string): Promise<GitStatus | null> {
  try {
    const inside = (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim()
    if (inside !== 'true') return null

    const [branch, porcelain] = await Promise.all([
      git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
      git(cwd, ['status', '--porcelain']),
    ])

    return { branch: branch.trim(), isDirty: porcelain.trim().length > 0 }
  } catch {
    return null
  }
}

export async function listBranches(cwd: string): Promise<string[]> {
  const stdout = await git(cwd, ['branch', '--format=%(refname:short)', '--sort=-committerdate'])
  return stdout.split('\n').map((l) => l.trim()).filter(Boolean)
}

export class GitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitError'
  }
}

/** Extrait le message d'erreur de git, bien plus parlant que « exit code 128 ». */
function gitMessage(err: unknown): string {
  const stderr = (err as { stderr?: string }).stderr
  const text = stderr?.trim() || (err instanceof Error ? err.message : String(err))
  return text.split('\n').slice(0, 3).join(' ').trim()
}

/**
 * Crée un worktree. `git worktree add` échoue si la branche existe déjà, donc on
 * bascule sur un rattachement plutôt que d'imposer un nom neuf : reprendre une branche
 * existante est un usage courant.
 */
export async function addWorktree(
  repo: string,
  path: string,
  branch: string,
  baseRef: string,
): Promise<{ reusedBranch: boolean }> {
  const branches = await listBranches(repo).catch((): string[] => [])
  const reusedBranch = branches.includes(branch)

  try {
    await git(
      repo,
      reusedBranch
        ? ['worktree', 'add', path, branch]
        : ['worktree', 'add', path, '-b', branch, baseRef],
    )
  } catch (err) {
    const message = gitMessage(err)
    // git répond « already used by worktree » : une branche ne peut être extraite que
    // dans un seul worktree à la fois. Le dire clairement évite de chercher longtemps.
    if (/already (checked out|used by worktree)/i.test(message)) {
      throw new GitError(
        `La branche « ${branch} » est déjà extraite dans un autre worktree ou dans le projet lui-même.`,
      )
    }
    throw new GitError(message)
  }
  return { reusedBranch }
}

export async function removeWorktree(repo: string, path: string, force: boolean): Promise<void> {
  try {
    await git(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), path])
  } catch (err) {
    throw new GitError(gitMessage(err))
  }
}

/**
 * État de tous les fichiers du dépôt, en un seul appel.
 *
 * Les codes de `--porcelain` sont réduits à ce que montre une arborescence : savoir
 * qu'un fichier est modifié dans l'index *et* dans le répertoire de travail n'apprend
 * rien à qui regarde une liste de fichiers.
 *
 * Un appel par fichier serait ruineux dans un dossier de plusieurs centaines
 * d'entrées, et l'explorateur en déplie un niveau à la fois. `-z` sépare par octet nul,
 * seul format qui survive à un nom de fichier contenant un espace ou un guillemet.
 *
 * Retourne null hors dépôt git : un projet peut pointer sur un dossier quelconque.
 */
export async function readFileStates(cwd: string): Promise<Map<string, FileState> | null> {
  let raw: string
  try {
    const inside = (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim()
    if (inside !== 'true') return null
    raw = await git(cwd, [
      'status',
      '--porcelain',
      '-z',
      '--untracked-files=all',
      '--ignored=matching',
    ])
  } catch {
    return null
  }

  const states = new Map<string, FileState>()
  const fields = raw.split('\0')

  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i]
    if (!field || field.length < 4) continue

    const code = field.slice(0, 2)
    let path = field.slice(3)

    // Un renommage occupe deux champs : le nouveau nom, puis l'ancien. C'est le
    // nouveau qui existe sur le disque, donc le suivant est consommé et ignoré.
    if (code[0] === 'R' || code[0] === 'C') i += 1

    // Git remonte les dossiers entièrement ignorés comme une seule entrée terminée
    // par un séparateur : la garder telle quelle ne correspondrait à aucune entrée.
    if (path.endsWith('/')) path = path.slice(0, -1)

    if (code === '!!') states.set(path, 'ignored')
    else if (code === '??') states.set(path, 'untracked')
    else if (code.includes('D')) states.set(path, 'deleted')
    else if (code.includes('A') || code[0] === 'R' || code[0] === 'C') states.set(path, 'added')
    else states.set(path, 'modified')
  }

  return states
}

/** Dernier commit, pour situer un diff vide. */
export interface HeadCommit {
  hash: string
  subject: string
  relativeDate: string
}

/**
 * Un dépôt sans commit n'a pas de HEAD : c'est un cas normal, pas une erreur.
 * Les champs sont séparés par un octet nul, seul séparateur qu'un sujet de commit ne
 * peut pas contenir.
 */
export async function readHeadCommit(cwd: string): Promise<HeadCommit | null> {
  try {
    const raw = await git(cwd, ['log', '-1', '--format=%h%x00%s%x00%cr'])
    const [hash, subject, relativeDate] = raw.trim().split('\0')
    if (!hash) return null
    return { hash, subject: subject ?? '', relativeDate: relativeDate ?? '' }
  } catch {
    return null
  }
}

export interface DiffFile {
  path: string
  added: number
  removed: number
}

export interface WorkingDiff {
  files: DiffFile[]
  /** Diff unifié complet, tronqué au-delà de `MAX_DIFF_BYTES`. */
  patch: string
  truncated: boolean
}

/** Un diff de plusieurs mégaoctets ne s'affiche pas et ne se transporte pas utilement. */
const MAX_DIFF_BYTES = 512 * 1024

/**
 * Modifications non commitées du répertoire de travail, fichiers non suivis compris :
 * un agent qui crée un fichier doit apparaître dans le diff, sinon la vue ment.
 *
 * Le passage par un index temporaire (`GIT_INDEX_FILE`) est ce qui rend l'opération
 * réellement en lecture seule : faire un `git add --intent-to-add` sur l'index réel
 * modifierait le dépôt de l'utilisateur juste pour afficher un onglet.
 */
export async function readWorkingDiff(cwd: string): Promise<WorkingDiff | null> {
  const status = await readGitStatus(cwd)
  if (!status) return null

  const gitDir = (await git(cwd, ['rev-parse', '--absolute-git-dir'])).trim()
  const scratchIndex = join(tmpdir(), `sillage-index-${randomUUID()}`)

  try {
    // On part d'une copie de l'index courant pour ne pas voir comme « ajoutés » des
    // fichiers déjà stagés par l'utilisateur. Un dépôt sans index encore écrit est un
    // cas normal, on repart alors d'un index vide.
    await copyFile(join(gitDir, 'index'), scratchIndex).catch(() => {})
    const env = { GIT_INDEX_FILE: scratchIndex }

    await git(cwd, ['add', '--intent-to-add', '--all'], env)

    const [numstat, patch] = await Promise.all([
      git(cwd, ['diff', 'HEAD', '--numstat'], env),
      git(cwd, ['diff', 'HEAD'], env),
    ])

    const files = numstat
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [added, removed, path] = line.split('\t')
        return {
          path: path ?? '',
          // Un fichier binaire donne « - » plutôt qu'un nombre.
          added: Number(added) || 0,
          removed: Number(removed) || 0,
        }
      })
      .filter((file) => file.path.length > 0)

    const truncated = Buffer.byteLength(patch) > MAX_DIFF_BYTES
    return {
      files,
      patch: truncated ? patch.slice(0, MAX_DIFF_BYTES) : patch,
      truncated,
    }
  } catch (err) {
    throw new GitError(gitMessage(err))
  } finally {
    await rm(scratchIndex, { force: true }).catch(() => {})
  }
}
