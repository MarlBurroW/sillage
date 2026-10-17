import { execFile } from 'node:child_process'
import { cp, lstat, mkdtemp, rm, rmdir, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { CheckpointFile } from '@sillage/protocol'

/**
 * Points de reprise d'un tour : l'état du workspace capturé avant et après.
 *
 * Chaque capture est un arbre git, référencé sous `refs/sillage/checkpoints/` et jamais
 * commité : la branche de l'utilisateur, son index et HEAD ne bougent pas, et `git log
 * --all` ne voit rien, une ref qui pointe sur un arbre n'ayant pas d'historique. Les
 * objets, eux, vivent dans le dépôt : c'est ce qui permet de differ deux captures avec
 * git lui-même, et de remettre les fichiers en place par `checkout-index`.
 *
 * La capture passe par un index temporaire (`GIT_INDEX_FILE`), copie de l'index réel
 * pour profiter de son cache de stat : sur un gros dépôt, `git add -u` n'a alors à
 * hacher que ce qui a changé. Les fichiers ignorés n'y entrent jamais, et un fichier
 * non suivi au-delà de `MAX_UNTRACKED_BYTES` non plus : une archive déposée dans le
 * workspace ne doit pas finir dans l'object store à chaque tour.
 *
 * Les refs sont communes à tous les worktrees du dépôt : nommées par conversation et
 * par tour, deux conversations dans deux worktrees ne se marchent pas dessus.
 */

/** Une capture ou une restauration qui traîne plus que ça est un dépôt hors d'usage. */
const TIMEOUT_MS = 60_000

/** Au-delà, un fichier non suivi n'est pas capturé, et jamais supprimé à la restauration. */
export const MAX_UNTRACKED_BYTES = 5 * 1024 * 1024

/** Au-delà, un diff de fichier ne s'affiche plus utilement. */
const MAX_PATCH_BYTES = 512 * 1024

export class CheckpointError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
  ) {
    super(detail || code)
    this.name = 'CheckpointError'
  }
}

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

function run(cwd: string, args: string[], env?: NodeJS.ProcessEnv, input?: string): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      'git',
      args,
      {
        cwd,
        timeout: TIMEOUT_MS,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', ...env },
      },
      (error, stdout, stderr) => {
        if (error) {
          const failure = error as NodeJS.ErrnoException & { killed?: boolean; code?: unknown }
          if (failure.killed) {
            reject(new CheckpointError('checkpoint_timeout', `git ${args[0]} took too long and was stopped.`))
            return
          }
          if (typeof failure.code !== 'number') {
            reject(new CheckpointError('checkpoint_git_failed', `git could not be started: ${failure.message}`))
            return
          }
          resolvePromise({ code: failure.code, stdout, stderr })
          return
        }
        resolvePromise({ code: 0, stdout, stderr })
      },
    )
    if (input !== undefined && child.stdin) {
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    }
  })
}

/** Une commande dont l'échec est une erreur : la sortie ou rien. */
async function read(cwd: string, args: string[], env?: NodeJS.ProcessEnv, input?: string): Promise<string> {
  const result = await run(cwd, args, env, input)
  if (result.code !== 0) {
    const detail = result.stderr.trim().split('\n').slice(0, 3).join(' ') || `git ${args[0]} exited with ${result.code}`
    throw new CheckpointError('checkpoint_git_failed', detail)
  }
  return result.stdout
}

function splitZ(raw: string): string[] {
  return raw.split('\0').filter((field) => field.length > 0)
}

interface Repo {
  /** Racine du worktree, telle que git la résout. */
  top: string
  /** Chemin du répertoire de la conversation sous la racine, avec `/` final, ou vide. */
  prefix: string
}

/**
 * Où est le dépôt, et où est le répertoire de la conversation dedans.
 *
 * Un projet peut pointer sous la racine d'un dépôt : la capture et la restauration ne
 * regardent alors que ce sous-arbre, et les chemins rendus lui sont relatifs, comme
 * ceux du reste du panneau. Null hors dépôt : un projet peut pointer n'importe où.
 */
async function locate(cwd: string): Promise<Repo | null> {
  const result = await run(cwd, ['rev-parse', '--show-toplevel', '--show-prefix'])
  if (result.code !== 0) return null
  const [top, prefix] = result.stdout.split('\n')
  if (!top) return null
  return { top, prefix: prefix ?? '' }
}

/** Le pathspec qui borne une commande au répertoire de la conversation. */
function scopeOf(repo: Repo): string[] {
  return repo.prefix ? ['--', repo.prefix] : []
}

function stripPrefix(repo: Repo, path: string): string {
  return repo.prefix && path.startsWith(repo.prefix) ? path.slice(repo.prefix.length) : path
}

export type CheckpointPhase = 'before' | 'after'

function refBase(conversationId: string): string {
  return `refs/sillage/checkpoints/${conversationId}`
}

export function checkpointRef(conversationId: string, key: string, phase: CheckpointPhase): string {
  return `${refBase(conversationId)}/${key}/${phase}`
}

export interface Snapshot {
  ref: string
  /** L'arbre du répertoire de travail : fichiers suivis et non suivis, sans les ignorés. */
  tree: string
  /** L'arbre de l'index au même moment ; null s'il portait des conflits. */
  indexTree: string | null
  /** HEAD au même moment ; null sur un dépôt sans commit. */
  head: string | null
}

interface Meta {
  head: string | null
  indexTree: string | null
  ts: number
}

/**
 * Capture l'état du workspace sous une ref.
 *
 * Un fichier en conflit est capturé tel qu'il est sur le disque, marqueurs compris :
 * c'est bien l'état du workspace. L'index, lui, ne se laisse pas écrire en arbre tant
 * qu'il a des entrées non fusionnées ; la capture le note comme absent, et la
 * restauration le laissera alors tel quel.
 */
export async function captureSnapshot(cwd: string, ref: string): Promise<Snapshot> {
  const repo = await locate(cwd)
  if (!repo) throw new CheckpointError('checkpoint_not_repository', 'This directory is not inside a git repository.')

  const tmp = await mkdtemp(join(tmpdir(), 'sillage-checkpoint-'))
  try {
    const indexPath = resolve(repo.top, (await read(repo.top, ['rev-parse', '--git-path', 'index'])).trim())
    const workIndex = join(tmp, 'work')
    const snapIndex = join(tmp, 'snap')
    // Un dépôt tout juste initialisé n'a pas encore d'index : on part alors de rien.
    await cp(indexPath, workIndex).catch(() => {})
    await cp(indexPath, snapIndex).catch(() => {})

    const work = { GIT_INDEX_FILE: workIndex }
    const scope = scopeOf(repo)
    await read(repo.top, ['add', '-u', '--ignore-errors', '--', repo.prefix || '.'], work)

    const untracked = splitZ(await read(repo.top, ['ls-files', '-z', '-o', '--exclude-standard', ...scope], work))
    const kept: string[] = []
    for (const path of untracked) {
      const info = await lstat(join(repo.top, path)).catch(() => null)
      if (!info) continue
      if (info.isFile() && info.size > MAX_UNTRACKED_BYTES) continue
      if (!info.isFile() && !info.isSymbolicLink()) continue
      kept.push(path)
    }
    if (kept.length > 0) {
      await read(repo.top, ['update-index', '--add', '-z', '--stdin'], work, `${kept.join('\0')}\0`)
    }
    const tree = (await read(repo.top, ['write-tree'], work)).trim()

    const indexWrite = await run(repo.top, ['write-tree'], { GIT_INDEX_FILE: snapIndex })
    const indexTree = indexWrite.code === 0 ? indexWrite.stdout.trim() : null

    const headResult = await run(repo.top, ['rev-parse', '--verify', '-q', 'HEAD'])
    const head = headResult.code === 0 ? headResult.stdout.trim() : null

    const meta: Meta = { head, indexTree, ts: Date.now() }
    const metaBlob = (await read(repo.top, ['hash-object', '-w', '--stdin'], undefined, JSON.stringify(meta))).trim()
    const wrapper = (
      await read(
        repo.top,
        ['mktree', '-z'],
        undefined,
        [
          `040000 tree ${tree}\tworktree`,
          ...(indexTree ? [`040000 tree ${indexTree}\tindex`] : []),
          `100644 blob ${metaBlob}\tmeta`,
        ].join('\0') + '\0',
      )
    ).trim()
    await read(repo.top, ['update-ref', ref, wrapper])

    return { ref, tree, indexTree, head }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

/** Relit une capture. Null si la ref n'existe plus : conversation nettoyée, dépôt recloné. */
export async function readSnapshot(cwd: string, ref: string): Promise<Snapshot | null> {
  const repo = await locate(cwd)
  if (!repo) return null
  const exists = await run(repo.top, ['rev-parse', '--verify', '-q', `${ref}^{tree}`])
  if (exists.code !== 0) return null

  const tree = (await read(repo.top, ['rev-parse', `${ref}:worktree`])).trim()
  let meta: Meta = { head: null, indexTree: null, ts: 0 }
  try {
    meta = JSON.parse(await read(repo.top, ['cat-file', '-p', `${ref}:meta`])) as Meta
  } catch {
    // Une capture sans méta reste utilisable : on ne saura juste pas où était HEAD.
  }
  return { ref, tree, indexTree: meta.indexTree ?? null, head: meta.head ?? null }
}

const KINDS: Record<string, CheckpointFile['kind']> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'typechange',
}

/**
 * Lignes ajoutées et retirées par fichier, depuis `--numstat -z`. Un renommage occupe
 * trois champs : les compteurs suivis d'un chemin vide, puis l'ancien et le nouveau nom.
 */
function parseNumstat(raw: string): Map<string, { added: number | null; removed: number | null }> {
  const counts = new Map<string, { added: number | null; removed: number | null }>()
  const fields = raw.split('\0')
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i]
    if (!field) continue
    const [added, removed, path] = field.split('\t')
    if (path === undefined) continue
    const target = path === '' ? fields[(i += 2)] : path
    if (!target) continue
    counts.set(target, {
      added: added === '-' ? null : Number(added),
      removed: removed === '-' ? null : Number(removed),
    })
  }
  return counts
}

/** Nature de chaque changement, depuis `--name-status -z`. Un R ou un C porte deux chemins. */
function parseNameStatus(raw: string): CheckpointFile[] {
  const fields = splitZ(raw)
  const files: CheckpointFile[] = []
  for (let i = 0; i < fields.length; i += 1) {
    const status = fields[i]?.[0] ?? ''
    const kind = KINDS[status]
    if (!kind) continue
    if (status === 'R' || status === 'C') {
      const oldPath = fields[i + 1] ?? ''
      const path = fields[i + 2] ?? ''
      i += 2
      files.push({ path, oldPath, kind, added: null, removed: null })
    } else {
      const path = fields[i + 1] ?? ''
      i += 1
      files.push({ path, oldPath: null, kind, added: null, removed: null })
    }
  }
  return files
}

export interface CheckpointDiff {
  files: CheckpointFile[]
  /** Fichiers que git a apportés pendant le tour (pull, merge, rebase), écartés. */
  excluded: number
}

/** Un chemin tel que le journal le porte, ramené à la racine du dépôt. */
function toRepoPath(repo: Repo, cwd: string, path: string): string | null {
  const rel = isAbsolute(path) ? relative(repo.top, path) : relative(repo.top, resolve(cwd, path))
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  return rel
}

/**
 * Ce que le tour a changé, entre ses deux captures.
 *
 * Quand HEAD a bougé pendant le tour, tout ce que git a changé entre les deux HEAD et
 * que l'agent n'a pas touché lui-même est écarté : un pull ou une fusion apportent des
 * fichiers qui ne sont pas le travail du tour. Un fichier que l'agent a édité reste
 * listé même s'il l'a commité ensuite. Limite connue : un fichier modifié par une
 * commande shell, hors des outils d'édition, puis commité, est écarté lui aussi.
 */
export async function diffCheckpoint(
  cwd: string,
  conversationId: string,
  key: string,
  edited: string[],
): Promise<CheckpointDiff> {
  const repo = await locate(cwd)
  if (!repo) throw new CheckpointError('checkpoint_not_repository', 'This directory is not inside a git repository.')
  const before = await readSnapshot(cwd, checkpointRef(conversationId, key, 'before'))
  const after = await readSnapshot(cwd, checkpointRef(conversationId, key, 'after'))
  if (!before || !after) {
    throw new CheckpointError('checkpoint_missing', 'The captures of this turn are no longer in the repository.')
  }

  const scope = scopeOf(repo)
  const [numstat, nameStatus] = await Promise.all([
    read(repo.top, ['diff-tree', '-r', '-M', '-z', '--numstat', before.tree, after.tree, ...scope]),
    read(repo.top, ['diff-tree', '-r', '-M', '-z', '--name-status', before.tree, after.tree, ...scope]),
  ])
  const counts = parseNumstat(numstat)

  let broughtByGit = new Set<string>()
  if (before.head && after.head && before.head !== after.head) {
    // Un HEAD réécrit depuis n'est plus lisible : on ne sait alors rien écarter.
    const moved = await run(repo.top, ['diff-tree', '-r', '-z', '--name-only', before.head, after.head, ...scope])
    if (moved.code === 0) broughtByGit = new Set(splitZ(moved.stdout))
  }
  const editedSet = new Set(edited.map((path) => toRepoPath(repo, cwd, path)).filter((path) => path !== null))

  let excluded = 0
  const files: CheckpointFile[] = []
  for (const file of parseNameStatus(nameStatus)) {
    const own = editedSet.has(file.path) || (file.oldPath !== null && editedSet.has(file.oldPath))
    if (!own && broughtByGit.has(file.path)) {
      excluded += 1
      continue
    }
    files.push({
      ...file,
      path: stripPrefix(repo, file.path),
      oldPath: file.oldPath === null ? null : stripPrefix(repo, file.oldPath),
      ...counts.get(file.path),
    })
  }
  return { files, excluded }
}

/** Le diff d'un fichier entre les deux captures, lu quand on le déplie et pas avant. */
export async function readCheckpointFileDiff(
  cwd: string,
  conversationId: string,
  key: string,
  path: string,
  oldPath: string | null,
): Promise<{ patch: string; truncated: boolean }> {
  const repo = await locate(cwd)
  if (!repo) throw new CheckpointError('checkpoint_not_repository', 'This directory is not inside a git repository.')
  const before = await readSnapshot(cwd, checkpointRef(conversationId, key, 'before'))
  const after = await readSnapshot(cwd, checkpointRef(conversationId, key, 'after'))
  if (!before || !after) {
    throw new CheckpointError('checkpoint_missing', 'The captures of this turn are no longer in the repository.')
  }

  const paths = [repo.prefix + path, ...(oldPath ? [repo.prefix + oldPath] : [])]
  const patch = await read(repo.top, ['diff-tree', '-r', '-p', '-M', before.tree, after.tree, '--', ...paths])
  const truncated = Buffer.byteLength(patch) > MAX_PATCH_BYTES
  return { patch: truncated ? patch.slice(0, MAX_PATCH_BYTES) : patch, truncated }
}

export interface RestoreResult {
  written: number
  deleted: number
  indexRestored: boolean
}

/** Retire les dossiers qu'une suppression a laissés vides, sans remonter au-delà de la racine. */
async function pruneEmptyDirs(top: string, path: string): Promise<void> {
  let dir = dirname(resolve(top, path))
  while (dir.startsWith(top) && dir !== top) {
    try {
      await rmdir(dir)
    } catch {
      return
    }
    dir = dirname(dir)
  }
}

/**
 * Ramène le workspace à l'état d'une capture.
 *
 * Ne réécrit que ce qui diffère : un index temporaire chargé de l'arbre capturé, puis
 * rafraîchi, dit exactement quels fichiers ne sont plus ceux de la capture, et seuls
 * ceux-là passent par `checkout-index`. Tout réécrire changerait la date de chaque
 * fichier, et un outil de build y verrait un projet entier à recompiler.
 *
 * Les fichiers apparus depuis, suivis ou non, sont supprimés, sauf les ignorés, jamais
 * capturés, et les non suivis trop gros pour l'avoir été. L'index réel est remis à
 * l'état d'avant pour les seuls chemins concernés ; HEAD et les commits ne bougent pas,
 * un tour qui a commité laisse donc ses commits, et les fichiers reviennent en
 * modifications par rapport à eux.
 */
export async function restoreSnapshot(cwd: string, ref: string): Promise<RestoreResult> {
  const repo = await locate(cwd)
  if (!repo) throw new CheckpointError('checkpoint_not_repository', 'This directory is not inside a git repository.')
  const snapshot = await readSnapshot(cwd, ref)
  if (!snapshot) throw new CheckpointError('checkpoint_missing', 'The capture of this turn is no longer in the repository.')

  const scope = scopeOf(repo)
  const tmp = await mkdtemp(join(tmpdir(), 'sillage-restore-'))
  try {
    const work = { GIT_INDEX_FILE: join(tmp, 'index') }
    await read(repo.top, ['read-tree', snapshot.tree], work)
    // Sort en 1 dès qu'un fichier diffère : ce n'est pas une erreur, c'est la question posée.
    await run(repo.top, ['update-index', '--refresh', '-q'], work)
    const changed = splitZ(await read(repo.top, ['diff-files', '-z', '--name-only', ...scope], work))
    if (changed.length > 0) {
      await read(repo.top, ['checkout-index', '-f', '-q', '-z', '--stdin'], work, `${changed.join('\0')}\0`)
    }

    const captured = new Set(splitZ(await read(repo.top, ['ls-tree', '-r', '-z', '--name-only', snapshot.tree, ...scope])))
    const tracked = new Set(splitZ(await read(repo.top, ['ls-files', '-z', ...scope])))
    const untracked = splitZ(await read(repo.top, ['ls-files', '-z', '-o', '--exclude-standard', ...scope]))

    const deleted: string[] = []
    for (const path of [...tracked, ...untracked]) {
      if (captured.has(path)) continue
      const info = await lstat(join(repo.top, path)).catch(() => null)
      if (!info) continue
      if (info.isFile() && info.size > MAX_UNTRACKED_BYTES && !tracked.has(path)) continue
      await unlink(join(repo.top, path))
      await pruneEmptyDirs(repo.top, path)
      deleted.push(path)
    }

    if (snapshot.indexTree) {
      const staged = splitZ(
        (await run(repo.top, ['diff-index', '--cached', '-z', '--name-only', snapshot.indexTree, ...scope])).stdout,
      )
      const touched = new Set([...changed, ...deleted, ...staged])
      const entries = new Map<string, string>()
      for (const line of splitZ(await read(repo.top, ['ls-tree', '-r', '-z', snapshot.indexTree, ...scope]))) {
        const [info, path] = line.split('\t')
        if (!info || !path) continue
        const [mode, , sha] = info.split(' ')
        if (mode && sha) entries.set(path, `${mode} ${sha}\t${path}`)
      }
      const keep: string[] = []
      const drop: string[] = []
      for (const path of touched) {
        const entry = entries.get(path)
        if (entry) keep.push(entry)
        else drop.push(path)
      }
      if (keep.length > 0) await read(repo.top, ['update-index', '-z', '--index-info'], undefined, `${keep.join('\0')}\0`)
      if (drop.length > 0) await read(repo.top, ['update-index', '-z', '--force-remove', '--stdin'], undefined, `${drop.join('\0')}\0`)
    }

    return { written: changed.length, deleted: deleted.length, indexRestored: snapshot.indexTree !== null }
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

/**
 * Donne à une branche de conversation les captures de sa source.
 *
 * Le journal recopié au fork porte les mêmes clés : sans leurs refs, la branche
 * montrerait des repères qui ne mènent à rien. Les refs pointent sur les mêmes arbres,
 * rien n'est dupliqué dans l'object store ; chaque conversation garde ensuite les
 * siennes, et le nettoyage de l'une ne touche pas l'autre.
 */
export async function copyCheckpoints(cwd: string, fromId: string, toId: string): Promise<number> {
  const repo = await locate(cwd)
  if (!repo) return 0
  const base = `${refBase(fromId)}/`
  const entries = (await read(repo.top, ['for-each-ref', '--format=%(objectname) %(refname)', base]))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (entries.length === 0) return 0
  const script = entries
    .map((entry) => {
      const [object, ref] = entry.split(' ')
      return `create ${refBase(toId)}/${ref!.slice(base.length)} ${object}\n`
    })
    .join('')
  await read(repo.top, ['update-ref', '--stdin'], undefined, script)
  return entries.length
}

/** Retire toutes les captures d'une conversation. Sans effet hors dépôt ou sans capture. */
export async function deleteCheckpoints(cwd: string, conversationId: string): Promise<number> {
  const repo = await locate(cwd)
  if (!repo) return 0
  const refs = (await read(repo.top, ['for-each-ref', '--format=%(refname)', `${refBase(conversationId)}/`]))
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (refs.length === 0) return 0
  await read(repo.top, ['update-ref', '--stdin'], undefined, refs.map((ref) => `delete ${ref}\n`).join(''))
  return refs.length
}
