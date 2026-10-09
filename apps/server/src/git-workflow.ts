import { execFile } from 'node:child_process'
import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import type {
  GitActionDto,
  GitArea,
  GitBranchDto,
  GitBranchesDto,
  GitChangeDto,
  GitChangeKind,
  GitCommitResultDto,
  GitFileDiffDto,
  GitOperation,
  GitRemoteBranchDto,
  GitRepoStatusDto,
  GitResetMode,
  GitStashDto,
} from '@sillage/protocol'

/**
 * Le workflow git du panneau : ce qu'on fait d'un dépôt au quotidien sans ouvrir un
 * terminal. Index, commit, branches, remote, stash.
 *
 * Séparé de `git.ts`, qui ne fait que lire pour afficher : ici chaque fonction modifie
 * le dépôt de l'utilisateur, et les erreurs de git deviennent des codes que l'interface
 * sait traduire et, souvent, proposer de résoudre (forcer, stasher, rebaser).
 *
 * Tout passe par `git` lui-même, jamais par une réimplémentation : les hooks du dépôt,
 * sa configuration (`pull.rebase`, `commit.gpgsign`, `core.hooksPath`) et son helper de
 * credentials s'appliquent exactement comme depuis le shell de l'utilisateur.
 */

/** Lectures d'état, qui ne touchent pas au réseau. Large pour un gros dépôt à froid. */
const READ_TIMEOUT_MS = 15_000
/** Actions locales. Un hook de pre-commit qui lance un linter peut prendre son temps. */
const LOCAL_TIMEOUT_MS = 120_000
/** Fetch, pull, push : la ligne décide, pas nous. */
const NETWORK_TIMEOUT_MS = 180_000

/** Au-delà, un diff de fichier ne s'affiche plus utilement. */
const MAX_PATCH_BYTES = 512 * 1024

/**
 * Erreur d'une action git, sous la forme que l'interface traduit.
 *
 * `code` nomme la situation quand git la dit clairement (rien à commiter, branche non
 * fusionnée, push rejeté) : l'interface y attache une phrase et parfois un remède.
 * `detail` garde ce que git a écrit, qui reste le plus précis dans tous les autres cas.
 */
export class GitActionError extends Error {
  constructor(
    readonly code: string,
    readonly detail: string,
  ) {
    super(detail || code)
    this.name = 'GitActionError'
  }
}

interface RunOptions {
  timeout?: number
  env?: NodeJS.ProcessEnv
  input?: string
}

interface RunResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * Lance git et rend sa sortie quel que soit son code de retour : c'est l'appelant qui
 * sait si un code non nul est une erreur (un `commit` sans rien) ou un état (une
 * fusion qui laisse des conflits). Seuls l'absence de git et le délai dépassé lèvent.
 */
function exec(cwd: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      'git',
      args,
      {
        cwd,
        timeout: options.timeout ?? READ_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, ...options.env },
      },
      (error, stdout, stderr) => {
        if (error) {
          const failure = error as NodeJS.ErrnoException & {
            killed?: boolean
            signal?: string | null
            code?: unknown
          }
          if (failure.killed || failure.signal === 'SIGTERM') {
            reject(new GitActionError('git_timeout', `git ${args[0]} took too long and was stopped.`))
            return
          }
          if (typeof failure.code !== 'number') {
            reject(new GitActionError('git_failed', `git could not be started: ${failure.message}`))
            return
          }
          resolvePromise({ code: failure.code, stdout, stderr })
          return
        }
        resolvePromise({ code: 0, stdout, stderr })
      },
    )

    if (options.input !== undefined && child.stdin) {
      child.stdin.on('error', () => {})
      child.stdin.end(options.input)
    }
  })
}

/** Lecture dont l'échec est une erreur : la sortie ou rien. */
async function read(cwd: string, args: string[], options: RunOptions = {}): Promise<string> {
  const result = await exec(cwd, args, options)
  if (result.code !== 0) throw classify(result, args)
  return result.stdout
}

/** Les trois dernières lignes utiles de ce que git a écrit, le reste est du bruit de progression. */
function tail(result: RunResult): string {
  return `${result.stderr}\n${result.stdout}`
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('hint:') && !line.startsWith('remote:'))
    .slice(-3)
    .join(' ')
}

/**
 * Nomme ce que git a refusé, quand il le dit d'une façon reconnaissable.
 *
 * Les motifs suivent les messages de git tels qu'ils sont écrits depuis des années ;
 * un message qui n'y est pas reste un échec générique, avec le texte de git en détail,
 * qui dit toujours plus qu'une reformulation.
 */
function classify(result: RunResult, args: string[]): GitActionError {
  const text = `${result.stderr}\n${result.stdout}`
  const detail = tail(result) || `git ${args.join(' ')} exited with ${result.code}`

  const rules: [RegExp, string][] = [
    [/index\.lock|Another git process seems to be running/i, 'git_index_locked'],
    [/nothing to commit|no changes added to commit|nothing added to commit/i, 'git_nothing_to_commit'],
    [/Please tell me who you are|unable to auto-detect email address|empty ident name/i, 'git_identity_missing'],
    [/unmerged files|Unmerged paths|needs merge|unresolved conflict/i, 'git_unmerged_paths'],
    [/would be overwritten by (checkout|merge|switch)|commit your changes or stash them/i, 'git_dirty_worktree'],
    [/used by worktree|checked out at|already checked out/i, 'git_branch_in_worktree'],
    [/not fully merged/i, 'git_branch_unmerged'],
    [/already exists/i, 'git_ref_exists'],
    [/divergent branches|how to reconcile/i, 'git_pull_diverged'],
    [/no tracking information|has no upstream branch|no upstream configured/i, 'git_no_upstream'],
    [/could not read Username|terminal prompts disabled|Authentication failed|Permission denied|Invalid username or (password|token)/i, 'git_auth_failed'],
    [/\[rejected\]|failed to push some refs|non-fast-forward|stale info/i, 'git_push_rejected'],
    [/No configured push destination|does not appear to be a git repository|No such remote|Could not resolve host|Could not read from remote repository/i, 'git_remote_unreachable'],
    [/not something we can merge|unknown revision|bad revision|Could not parse object|did not match any file\(s\) known to git|invalid reference/i, 'git_unknown_ref'],
  ]

  for (const [pattern, code] of rules) {
    if (pattern.test(text)) return new GitActionError(code, detail)
  }
  return new GitActionError('git_failed', detail)
}

/**
 * Ce que git a dit d'utile, en une ligne : « Already up to date. », « Everything
 * up-to-date », le nom de la branche publiée. Les lignes de transport et de progression
 * n'apprennent rien à qui n'a pas le terminal sous les yeux.
 */
function summarize(result: RunResult): string | null {
  const lines = `${result.stdout}\n${result.stderr}`
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        !/^(remote:|To |From |hint:|warning:|Enumerating|Counting|Compressing|Writing|Total|Delta|Resolving|Receiving|Unpacking|Updating|Fetching)/.test(
          line,
        ) &&
        !/^[0-9a-f]{7,}\.\.[0-9a-f]{7,}\s/.test(line) &&
        !/^[+*-]?\s*\[/.test(line),
    )
  return lines.at(-1) ?? null
}

/**
 * Une action à la fois par dépôt.
 *
 * Deux clics rapprochés, ou un clic pendant qu'un agent commite, finissent sinon sur
 * « index.lock exists » : git ne fait pas la queue, il refuse. La sérialisation ne
 * protège que de nous-mêmes, mais c'est le cas le plus fréquent.
 */
const queues = new Map<string, Promise<unknown>>()

export function serialized<T>(cwd: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(cwd) ?? Promise.resolve()
  const next = previous.then(task, task)
  queues.set(cwd, next.catch(() => {}))
  return next
}

/**
 * Environnement des commandes qui parlent au remote.
 *
 * `GIT_TERMINAL_PROMPT=0` : sans terminal, un git qui demande un mot de passe resterait
 * bloqué jusqu'au délai au lieu d'échouer. Le helper de Sillage est ajouté en dernier
 * recours, après ceux que le dépôt et l'utilisateur ont déjà : un dépôt cloné par
 * Sillage l'a dans sa configuration, un dépôt ajouté depuis le disque non, et c'est pour
 * celui-là que le jeton enregistré doit quand même servir.
 */
export function networkEnv(credentialHelper: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' }
  if (credentialHelper) {
    env.GIT_CONFIG_COUNT = '1'
    env.GIT_CONFIG_KEY_0 = 'credential.helper'
    env.GIT_CONFIG_VALUE_0 = credentialHelper
  }
  return env
}

/** Pas d'éditeur : un message par défaut suffit à une fusion ou un revert. */
const NO_EDITOR: NodeJS.ProcessEnv = { GIT_EDITOR: 'true' }

// État

const KINDS: Record<string, GitChangeKind> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'typechange',
}

/**
 * Lignes ajoutées et retirées par fichier, depuis `--numstat -z`.
 *
 * Un renommage occupe trois champs : les compteurs suivis d'un chemin vide, puis
 * l'ancien et le nouveau nom. Un binaire donne « - » à la place des nombres.
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

interface Porcelain {
  oid: string | null
  head: string | null
  upstream: string | null
  ahead: number
  behind: number
  staged: GitChangeDto[]
  unstaged: GitChangeDto[]
  conflicted: GitChangeDto[]
}

/**
 * Découpe `git status --porcelain=v2 --branch -z`.
 *
 * Le format v2 est le seul qui dise à la fois l'état de l'index et celui du répertoire
 * de travail pour chaque fichier, avec l'amont de la branche et son avance. `-z`
 * sépare par octet nul, seul séparateur qui survive à un nom de fichier contenant un
 * espace ; le chemin d'origine d'un renommage arrive alors dans le champ suivant.
 */
function parsePorcelain(raw: string): Porcelain {
  const status: Porcelain = {
    oid: null,
    head: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    conflicted: [],
  }

  const fields = raw.split('\0')
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i]
    if (!field) continue

    if (field.startsWith('# ')) {
      const [key, ...rest] = field.slice(2).split(' ')
      const value = rest.join(' ')
      if (key === 'branch.oid') status.oid = value === '(initial)' ? null : value
      else if (key === 'branch.head') status.head = value === '(detached)' ? null : value
      else if (key === 'branch.upstream') status.upstream = value
      else if (key === 'branch.ab') {
        const match = /\+(\d+) -(\d+)/.exec(value)
        status.ahead = Number(match?.[1] ?? 0)
        status.behind = Number(match?.[2] ?? 0)
      }
      continue
    }

    const tag = field[0]
    const tokens = field.split(' ')

    if (tag === '?') {
      status.unstaged.push({
        path: field.slice(2),
        oldPath: null,
        kind: 'untracked',
        added: null,
        removed: null,
      })
      continue
    }

    if (tag === 'u') {
      status.conflicted.push({
        path: tokens.slice(10).join(' '),
        oldPath: null,
        kind: 'conflicted',
        added: null,
        removed: null,
      })
      continue
    }

    if (tag !== '1' && tag !== '2') continue

    const xy = tokens[1] ?? '..'
    const index = xy[0] ?? '.'
    const worktree = xy[1] ?? '.'
    const path = tokens.slice(tag === '2' ? 9 : 8).join(' ')
    // Le chemin d'origine n'existe que pour une entrée « 2 », et c'est le champ suivant.
    const origin = tag === '2' ? (fields[(i += 1)] ?? null) : null

    if (index !== '.') {
      status.staged.push({
        path,
        oldPath: index === 'R' || index === 'C' ? origin : null,
        kind: KINDS[index] ?? 'modified',
        added: null,
        removed: null,
      })
    }
    if (worktree !== '.') {
      status.unstaged.push({
        path,
        oldPath: worktree === 'R' || worktree === 'C' ? origin : null,
        kind: KINDS[worktree] ?? 'modified',
        added: null,
        removed: null,
      })
    }
  }

  return status
}

/**
 * L'opération que git a laissée en suspens, d'après les fichiers qu'il pose dans son
 * répertoire pour s'en souvenir lui-même : c'est ce que regarde son invite de shell.
 */
async function readOperation(cwd: string): Promise<GitOperation | null> {
  const raw = await read(cwd, [
    'rev-parse',
    '--git-path', 'rebase-merge',
    '--git-path', 'rebase-apply',
    '--git-path', 'MERGE_HEAD',
    '--git-path', 'CHERRY_PICK_HEAD',
    '--git-path', 'REVERT_HEAD',
    '--git-path', 'BISECT_LOG',
  ])
  const [rebaseMerge, rebaseApply, merge, cherryPick, revert, bisect] = raw
    .trim()
    .split('\n')
    .map((path) => resolve(cwd, path))

  const exists = (path: string | undefined) =>
    path ? stat(path).then(() => true, () => false) : Promise.resolve(false)

  const [isRebase1, isRebase2, isMerge, isCherry, isRevert, isBisect] = await Promise.all([
    exists(rebaseMerge),
    exists(rebaseApply),
    exists(merge),
    exists(cherryPick),
    exists(revert),
    exists(bisect),
  ])

  if (isRebase1 || isRebase2) return 'rebase'
  if (isMerge) return 'merge'
  if (isCherry) return 'cherry-pick'
  if (isRevert) return 'revert'
  if (isBisect) return 'bisect'
  return null
}

/**
 * L'état complet du dépôt, en une lecture.
 *
 * Six processus git, lancés ensemble : les enchaîner multiplierait d'autant le temps
 * d'ouverture de l'onglet. `GIT_OPTIONAL_LOCKS=0` sur le statut : sans lui, `git
 * status` prend le verrou de l'index pour rafraîchir son cache, et entrerait en
 * collision avec un agent en train de commiter.
 *
 * Retourne null hors dépôt : un projet peut pointer sur un dossier quelconque.
 */
export async function readRepoStatus(cwd: string): Promise<GitRepoStatusDto | null> {
  const inside = await exec(cwd, ['rev-parse', '--is-inside-work-tree'])
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return null

  const quiet = { env: { GIT_OPTIONAL_LOCKS: '0' } }
  const [porcelain, stagedStat, unstagedStat, head, remotes, stashes, operation] =
    await Promise.all([
      read(cwd, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all'], quiet),
      exec(cwd, ['diff', '--cached', '--numstat', '-z', '-M'], quiet),
      exec(cwd, ['diff', '--numstat', '-z', '-M'], quiet),
      // Échoue sur un dépôt sans commit : c'est un état normal, pas une panne.
      exec(cwd, ['log', '-1', '--format=%H%x00%h%x00%s%x00%b']),
      read(cwd, ['remote']),
      exec(cwd, ['rev-list', '--walk-reflogs', '--count', 'refs/stash']),
      readOperation(cwd),
    ])

  const status = parsePorcelain(porcelain)
  const stagedCounts = parseNumstat(stagedStat.stdout)
  const unstagedCounts = parseNumstat(unstagedStat.stdout)
  const withCounts = (
    changes: GitChangeDto[],
    counts: Map<string, { added: number | null; removed: number | null }>,
  ) => changes.map((change) => ({ ...change, ...counts.get(change.path) }))

  let headCommit: GitRepoStatusDto['head'] = null
  if (head.code === 0 && head.stdout.length > 0) {
    const [hash, shortHash, subject, body] = head.stdout.split('\0')
    if (hash) {
      headCommit = {
        hash,
        shortHash: shortHash ?? '',
        subject: subject ?? '',
        body: (body ?? '').trim(),
      }
    }
  }

  return {
    branch: status.head,
    detached: status.head === null && status.oid !== null,
    unborn: status.oid === null,
    head: headCommit,
    upstream: status.upstream,
    ahead: status.ahead,
    behind: status.behind,
    operation,
    remotes: remotes.split('\n').map((line) => line.trim()).filter(Boolean),
    staged: withCounts(status.staged, stagedCounts),
    unstaged: withCounts(status.unstaged, unstagedCounts),
    conflicted: status.conflicted,
    stashCount: stashes.code === 0 ? Number(stashes.stdout.trim()) || 0 : 0,
  }
}

/**
 * Le diff d'un seul fichier, dans la zone demandée.
 *
 * Par fichier et à la demande, plutôt que tout le diff d'un coup : un dépôt avec deux
 * cents fichiers modifiés n'a pas à transporter deux cents patches pour en déplier un.
 * Un fichier non suivi n'a rien dans l'index à comparer : `--no-index` contre le vide
 * le montre entièrement ajouté, et sort en 1 quand il y a une différence, ce qui est
 * ici le cas attendu.
 */
export async function readFileDiff(cwd: string, path: string, area: GitArea): Promise<GitFileDiffDto> {
  const args =
    area === 'staged'
      ? ['diff', '--cached', '-M', '--', path]
      : area === 'untracked'
        ? ['diff', '--no-index', '--', '/dev/null', path]
        : ['diff', '-M', '--', path]

  const result = await exec(cwd, args, { env: { GIT_OPTIONAL_LOCKS: '0' } })
  if (result.code !== 0 && !(area === 'untracked' && result.code === 1)) throw classify(result, args)

  const truncated = Buffer.byteLength(result.stdout) > MAX_PATCH_BYTES
  return { patch: truncated ? result.stdout.slice(0, MAX_PATCH_BYTES) : result.stdout, truncated }
}

// Index

/** Ajoute à l'index. Sans chemin, tout le répertoire de travail, suppressions comprises. */
export async function stage(cwd: string, paths?: string[]): Promise<void> {
  await read(cwd, paths ? ['add', '-A', '--', ...paths] : ['add', '-A'], { timeout: LOCAL_TIMEOUT_MS })
}

/**
 * Retire de l'index, sans toucher au répertoire de travail. `reset` et non `restore
 * --staged` : seul le premier fonctionne sur un dépôt qui n'a pas encore de commit.
 */
export async function unstage(cwd: string, paths?: string[]): Promise<void> {
  await read(cwd, paths ? ['reset', '-q', '--', ...paths] : ['reset', '-q'], { timeout: LOCAL_TIMEOUT_MS })
}

/**
 * Abandonne les modifications du répertoire de travail sur ces chemins.
 *
 * Un fichier suivi revient à sa version de l'index, un fichier non suivi est supprimé :
 * deux commandes, parce que `checkout` ne connaît pas le second et `clean` ignore le
 * premier. La répartition se fait d'après l'index, pas d'après ce que dit le client.
 */
export async function discard(cwd: string, paths: string[]): Promise<void> {
  const listed = await read(cwd, ['ls-files', '-z', '--', ...paths])
  const tracked = new Set(listed.split('\0').filter(Boolean))
  const untracked = paths.filter((path) => !tracked.has(path))

  if (tracked.size > 0) {
    await read(cwd, ['checkout', '-q', '--', ...paths.filter((path) => tracked.has(path))], {
      timeout: LOCAL_TIMEOUT_MS,
    })
  }
  if (untracked.length > 0) {
    await read(cwd, ['clean', '-f', '-d', '-q', '--', ...untracked], { timeout: LOCAL_TIMEOUT_MS })
  }
}

/**
 * Commite l'index.
 *
 * Le message passe par l'entrée standard et non par `-m` : un corps de plusieurs
 * paragraphes y garde sa mise en forme, et aucune limite de ligne de commande ne le
 * tronque. `--cleanup=whitespace` et non `strip` : une ligne qui commence par `#` fait
 * partie du message quand il n'y a pas d'éditeur pour y mettre des commentaires.
 */
export async function commit(
  cwd: string,
  message: string,
  options: { amend: boolean; stageAll: boolean },
): Promise<GitCommitResultDto> {
  if (options.stageAll) await stage(cwd)

  const result = await exec(
    cwd,
    ['commit', '--file=-', '--cleanup=whitespace', ...(options.amend ? ['--amend'] : [])],
    { input: `${message.trimEnd()}\n`, timeout: LOCAL_TIMEOUT_MS, env: NO_EDITOR },
  )
  if (result.code !== 0) throw classify(result, ['commit'])

  const hashes = await read(cwd, ['log', '-1', '--format=%H%x00%h'])
  const [hash, shortHash] = hashes.trim().split('\0')
  return { hash: hash ?? '', shortHash: shortHash ?? '', summary: null, conflicts: false }
}

// Branches

/** `[ahead 1, behind 2]`, `[gone]`, ou rien : ce que `%(upstream:track)` rend. */
function parseTrack(track: string): { ahead: number; behind: number; gone: boolean } {
  return {
    ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
    behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
    gone: track.includes('gone'),
  }
}

/**
 * Branches locales et distantes, de la plus récemment commitée à la plus ancienne.
 *
 * `%(worktreepath)` dit où une branche est extraite : une branche prise par un autre
 * worktree ne peut pas l'être ici, et l'interface doit le montrer plutôt que laisser
 * git le refuser. `origin/HEAD` est un alias, pas une branche : écarté d'après le nom
 * complet, parce que `refname:short` l'abrège en `origin`.
 */
export async function readBranches(cwd: string): Promise<GitBranchesDto> {
  const raw = await read(cwd, [
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname)%00%(refname:short)%00%(objectname:short)%00%(committerdate:unix)%00%(subject)%00%(upstream:short)%00%(upstream:track)%00%(HEAD)%00%(worktreepath)',
    'refs/heads',
    'refs/remotes',
  ])

  const local: GitBranchDto[] = []
  const remote: GitRemoteBranchDto[] = []

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const [refname, name, hash, ts, subject, upstream, track, headMark, worktreePath] = line.split('\0')
    if (!refname || !name || !hash) continue
    const entry = { hash, subject: subject ?? '', ts: Number(ts) * 1000 || 0 }

    if (refname.startsWith('refs/heads/')) {
      local.push({
        name,
        current: headMark === '*',
        ...entry,
        upstream: upstream || null,
        ...parseTrack(track ?? ''),
        worktreePath: worktreePath || null,
      })
    } else if (refname.startsWith('refs/remotes/') && !refname.endsWith('/HEAD')) {
      remote.push({ name, remote: name.split('/')[0] ?? '', ...entry })
    }
  }

  return { local, remote }
}

/** Nouvelle branche, extraite ou non. Sans point de départ, HEAD. */
export async function createBranch(
  cwd: string,
  name: string,
  from: string | undefined,
  checkout: boolean,
): Promise<void> {
  const start = from ? [from] : []
  await read(cwd, checkout ? ['switch', '-c', name, ...start] : ['branch', name, ...start], {
    timeout: LOCAL_TIMEOUT_MS,
  })
}

/**
 * Extrait une branche locale, une branche distante ou un commit.
 *
 * Trois commandes selon ce qu'est la référence, parce que `switch` les distingue : une
 * branche distante donne une branche locale du même nom qui la suit, un commit laisse
 * HEAD détachée. La nature est vérifiée ici, et non devinée d'après le nom.
 */
export async function checkout(cwd: string, ref: string): Promise<void> {
  const isLocal = (await exec(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${ref}`])).code === 0
  if (isLocal) {
    await read(cwd, ['switch', ref], { timeout: LOCAL_TIMEOUT_MS })
    return
  }

  const isRemote = (await exec(cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/${ref}`])).code === 0
  if (isRemote) {
    await read(cwd, ['switch', '--track', ref], { timeout: LOCAL_TIMEOUT_MS })
    return
  }

  await read(cwd, ['switch', '--detach', ref], { timeout: LOCAL_TIMEOUT_MS })
}

export async function deleteBranch(cwd: string, name: string, force: boolean): Promise<void> {
  await read(cwd, ['branch', force ? '-D' : '-d', name], { timeout: LOCAL_TIMEOUT_MS })
}

/**
 * Finit une action qui a pu laisser des conflits.
 *
 * Un code non nul n'est une erreur que si le dépôt n'est pas en attente de résolution :
 * une fusion arrêtée sur un conflit a réussi à faire ce qu'on lui demandait, elle
 * attend juste la suite.
 */
async function settle(cwd: string, result: RunResult, args: string[]): Promise<GitActionDto> {
  if (result.code === 0) return { summary: summarize(result), conflicts: false }

  const status = await readRepoStatus(cwd)
  if (status && (status.conflicted.length > 0 || status.operation !== null)) {
    return { summary: summarize(result), conflicts: true }
  }
  throw classify(result, args)
}

export async function merge(cwd: string, ref: string): Promise<GitActionDto> {
  const args = ['merge', '--no-edit', ref]
  return settle(cwd, await exec(cwd, args, { timeout: LOCAL_TIMEOUT_MS, env: NO_EDITOR }), args)
}

const ABORT: Record<GitOperation, string[]> = {
  merge: ['merge', '--abort'],
  rebase: ['rebase', '--abort'],
  'cherry-pick': ['cherry-pick', '--abort'],
  revert: ['revert', '--abort'],
  bisect: ['bisect', 'reset'],
}

const CONTINUE: Record<GitOperation, string[]> = {
  // Une fusion n'a pas de `--continue` : la conclure, c'est commiter.
  merge: ['commit', '--no-edit'],
  rebase: ['rebase', '--continue'],
  'cherry-pick': ['cherry-pick', '--continue'],
  revert: ['revert', '--continue'],
  bisect: ['bisect', 'reset'],
}

/** Abandonne l'opération en cours, quelle qu'elle soit, et remet le dépôt d'avant. */
export async function abortOperation(cwd: string): Promise<void> {
  const operation = await readOperation(cwd)
  if (!operation) throw new GitActionError('git_no_operation', 'No merge, rebase or similar operation is in progress.')
  await read(cwd, ABORT[operation], { timeout: LOCAL_TIMEOUT_MS })
}

/** Reprend l'opération en cours, une fois les conflits résolus et ajoutés à l'index. */
export async function continueOperation(cwd: string): Promise<GitActionDto> {
  const operation = await readOperation(cwd)
  if (!operation) throw new GitActionError('git_no_operation', 'No merge, rebase or similar operation is in progress.')
  const args = CONTINUE[operation]
  return settle(cwd, await exec(cwd, args, { timeout: LOCAL_TIMEOUT_MS, env: NO_EDITOR }), args)
}

// Remote

export async function fetch(cwd: string, env: NodeJS.ProcessEnv): Promise<GitActionDto> {
  const args = ['fetch', '--all', '--prune']
  const result = await exec(cwd, args, { timeout: NETWORK_TIMEOUT_MS, env })
  if (result.code !== 0) throw classify(result, args)
  return { summary: summarize(result), conflicts: false }
}

export async function pull(cwd: string, rebase: boolean | undefined, env: NodeJS.ProcessEnv): Promise<GitActionDto> {
  const args = ['pull', '--no-edit', ...(rebase === undefined ? [] : [rebase ? '--rebase' : '--no-rebase'])]
  return settle(cwd, await exec(cwd, args, { timeout: NETWORK_TIMEOUT_MS, env }), args)
}

/**
 * Publie la branche courante.
 *
 * Sans amont, la branche est publiée sous son nom et reliée, ce que `git push` seul
 * refuse de deviner. `--force-with-lease` plutôt que `--force` : il n'écrase que ce
 * qu'on a déjà vu au dernier fetch, et refuse le travail d'un autre arrivé entre-temps.
 */
export async function push(
  cwd: string,
  options: { force: boolean; remote: string | undefined },
  env: NodeJS.ProcessEnv,
): Promise<GitActionDto> {
  const upstream = await exec(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
  const force = options.force ? ['--force-with-lease'] : []

  let args: string[]
  if (upstream.code === 0) {
    args = ['push', ...force]
  } else {
    const branch = (await read(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    if (branch === 'HEAD') throw new GitActionError('git_detached_push', 'HEAD is detached: there is no branch to push.')
    const remotes = (await read(cwd, ['remote'])).split('\n').map((line) => line.trim()).filter(Boolean)
    const remote = options.remote ?? (remotes.includes('origin') ? 'origin' : remotes[0])
    if (!remote) throw new GitActionError('git_remote_unreachable', 'This repository has no remote to push to.')
    args = ['push', '--set-upstream', ...force, remote, branch]
  }

  const result = await exec(cwd, args, { timeout: NETWORK_TIMEOUT_MS, env })
  if (result.code !== 0) throw classify(result, args)
  return { summary: summarize(result), conflicts: false }
}

// Stash

/**
 * Les stashs, du plus récent au plus ancien.
 *
 * Le message de git porte la branche d'origine (« On main: … », « WIP on main: … ») :
 * elle est extraite parce que c'est ce qui dit où ré-appliquer le stash sans surprise.
 */
export async function readStashes(cwd: string): Promise<GitStashDto[]> {
  const raw = await read(cwd, ['stash', 'list', '-z', '--format=%gd%x1f%gs%x1f%ct'])
  return raw
    .split('\0')
    .filter(Boolean)
    .map((entry, index) => {
      const [, subject, ts] = entry.split('\x1f')
      const match = /^(?:WIP on|On) ([^:]+): (.*)$/s.exec(subject ?? '')
      return {
        index,
        branch: match?.[1] ?? null,
        message: match?.[2] ?? subject ?? '',
        ts: Number(ts) * 1000 || 0,
      }
    })
}

export async function stashPush(
  cwd: string,
  message: string | undefined,
  includeUntracked: boolean,
): Promise<GitActionDto> {
  const args = [
    'stash',
    'push',
    ...(includeUntracked ? ['--include-untracked'] : []),
    ...(message ? ['-m', message] : []),
  ]
  const result = await exec(cwd, args, { timeout: LOCAL_TIMEOUT_MS })
  if (result.code !== 0) throw classify(result, args)
  return { summary: summarize(result), conflicts: false }
}

/** Ré-applique un stash, en le gardant (`apply`) ou en le retirant (`pop`). */
export async function stashApply(cwd: string, index: number, pop: boolean): Promise<GitActionDto> {
  const args = ['stash', pop ? 'pop' : 'apply', `stash@{${index}}`]
  return settle(cwd, await exec(cwd, args, { timeout: LOCAL_TIMEOUT_MS }), args)
}

export async function stashDrop(cwd: string, index: number): Promise<void> {
  await read(cwd, ['stash', 'drop', `stash@{${index}}`], { timeout: LOCAL_TIMEOUT_MS })
}

// Commits

/** Un commit inverse, sans éditeur : le message par défaut de git nomme le commit annulé. */
export async function revertCommit(cwd: string, hash: string): Promise<GitActionDto> {
  const args = ['revert', '--no-edit', hash]
  return settle(cwd, await exec(cwd, args, { timeout: LOCAL_TIMEOUT_MS, env: NO_EDITOR }), args)
}

/** Ramène la branche à un commit. `hard` jette le travail en cours : à confirmer en amont. */
export async function resetTo(cwd: string, hash: string, mode: GitResetMode): Promise<void> {
  await read(cwd, ['reset', `--${mode}`, hash], { timeout: LOCAL_TIMEOUT_MS })
}

// Dépôt

/**
 * Fait du répertoire un dépôt git, sur une branche `main`.
 *
 * Le premier geste qu'on ferait dans un terminal sur un projet créé sans clone. Refusé
 * si le répertoire est déjà dans un dépôt : un `git init` imbriqué dans un dépôt parent
 * créerait un sous-dépôt que rien n'a demandé.
 */
export async function initRepository(cwd: string): Promise<void> {
  const inside = await exec(cwd, ['rev-parse', '--is-inside-work-tree'])
  if (inside.code === 0 && inside.stdout.trim() === 'true') {
    throw new GitActionError('git_already_repository', 'This directory is already inside a git repository.')
  }
  await read(cwd, ['init', '-q', '-b', 'main'], { timeout: LOCAL_TIMEOUT_MS })
}
