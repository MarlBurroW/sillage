import { z } from 'zod'
import { commitHashSchema } from './api.js'

/**
 * Le workflow git du panneau : index, commit, branches, remote, stash.
 *
 * Distinct des lectures de `api.ts` (diff de travail, commits), qui ne faisaient que
 * montrer : ici on agit sur le dépôt. Les schémas des corps sont stricts parce que
 * chaque valeur finit sur la ligne de commande de git, où un nom qui commence par `-`
 * deviendrait une option.
 */

/** Nature d'un changement, d'après la colonne XY de `git status --porcelain=v2`. */
export const gitChangeKindSchema = z.enum([
  'added',
  'modified',
  'deleted',
  'renamed',
  'copied',
  'typechange',
  'untracked',
  'conflicted',
])
export type GitChangeKind = z.infer<typeof gitChangeKindSchema>

export interface GitChangeDto {
  path: string
  /** Chemin d'origine d'un renommage ou d'une copie, null sinon. */
  oldPath: string | null
  kind: GitChangeKind
  /** Lignes ajoutées et retirées. Null pour un binaire, ou quand git ne les compte pas. */
  added: number | null
  removed: number | null
}

/** Opération à plusieurs temps laissée en cours : git attend qu'on la finisse ou l'abandonne. */
export const gitOperationSchema = z.enum(['merge', 'rebase', 'cherry-pick', 'revert', 'bisect'])
export type GitOperation = z.infer<typeof gitOperationSchema>

export interface GitRepoStatusDto {
  /** Branche courante, null en HEAD détachée. */
  branch: string | null
  /** Vrai quand HEAD ne pointe sur aucune branche. */
  detached: boolean
  /** Vrai quand le dépôt n'a encore aucun commit : pas de HEAD à comparer. */
  unborn: boolean
  head: { hash: string; shortHash: string; subject: string; body: string } | null
  /** Branche distante suivie (`origin/main`), null si la branche n'en a pas. */
  upstream: string | null
  ahead: number
  behind: number
  operation: GitOperation | null
  remotes: string[]
  /** Dans l'index, prêt à être commité. */
  staged: GitChangeDto[]
  /** Dans le répertoire de travail seulement, fichiers non suivis compris. */
  unstaged: GitChangeDto[]
  /** En conflit : à résoudre puis à marquer résolus (les ajouter à l'index). */
  conflicted: GitChangeDto[]
  stashCount: number
}

export interface GitStatusDto {
  cwd: string
  /** Null hors dépôt git : un projet peut pointer sur un dossier quelconque. */
  repo: GitRepoStatusDto | null
}

export interface GitBranchDto {
  name: string
  current: boolean
  hash: string
  subject: string
  /** Date du dernier commit, en millisecondes. */
  ts: number
  upstream: string | null
  ahead: number
  behind: number
  /** Vrai si la branche distante suivie a disparu. */
  gone: boolean
  /** Chemin du worktree où la branche est extraite, null si elle ne l'est nulle part. */
  worktreePath: string | null
}

export interface GitRemoteBranchDto {
  /** Nom complet, `origin/main`. */
  name: string
  remote: string
  hash: string
  subject: string
  ts: number
}

export interface GitBranchesDto {
  local: GitBranchDto[]
  remote: GitRemoteBranchDto[]
}

export interface GitStashDto {
  index: number
  message: string
  /** Branche sur laquelle le stash a été fait, telle que git l'inscrit dans le message. */
  branch: string | null
  ts: number
}

export interface GitStashListDto {
  stashes: GitStashDto[]
}

export interface GitFileDiffDto {
  patch: string
  truncated: boolean
}

/**
 * Résultat d'une action qui a réussi au sens de git, conflits compris : une fusion qui
 * laisse des conflits n'est pas une panne, c'est l'état normal avant leur résolution.
 */
export interface GitActionDto {
  /** Ce que git a dit d'utile, une ligne (« Already up to date. »), ou null. */
  summary: string | null
  /** Vrai quand l'action laisse des conflits à résoudre dans le répertoire de travail. */
  conflicts: boolean
}

export interface GitCommitResultDto extends GitActionDto {
  hash: string
  shortHash: string
}

// Corps des requêtes

/**
 * Un chemin relatif au dépôt, tel que `git status` le rend. Le bornage au dépôt est
 * l'affaire de git, qui refuse un pathspec hors de son arbre ; l'octet nul, lui, ne
 * passe pas une ligne de commande.
 */
const gitPathSchema = z.string().min(1).max(4096).refine((path) => !path.includes('\0'))

/** Absent, la portée est tout le répertoire de travail. */
export const gitPathsBodySchema = z.object({
  paths: z.array(gitPathSchema).min(1).max(5000).optional(),
})

/** Ces chemins-là sont obligatoires : abandonner « tout » se fait ligne à ligne, consciemment. */
export const gitDiscardBodySchema = z.object({
  paths: z.array(gitPathSchema).min(1).max(5000),
})

export const gitAreaSchema = z.enum(['staged', 'unstaged', 'untracked'])
export type GitArea = z.infer<typeof gitAreaSchema>

export const gitFileDiffQuerySchema = z.object({
  path: gitPathSchema,
  area: gitAreaSchema,
})

export const gitCommitBodySchema = z.object({
  message: z.string().trim().min(1).max(20_000),
  amend: z.boolean().default(false),
  /** Ajouter tout le répertoire de travail à l'index d'abord : le commit « tout » d'un geste. */
  stageAll: z.boolean().default(false),
})

/**
 * Un nom de référence tel que git l'accepte, et rien qui puisse passer pour une option
 * ou une plage (`-x`, `a..b`, `@{1}`). La règle de git est plus riche, mais ce qu'elle
 * refuse en plus échoue chez lui avec un message clair.
 */
export const gitRefSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[^\s~^:?*[\\]+$/, 'Nom de référence invalide')
  .refine((ref) => !ref.startsWith('-'), 'Un nom ne peut pas commencer par un tiret')
  .refine(
    (ref) => !ref.includes('..') && !ref.includes('@{') && !ref.endsWith('.lock'),
    'Nom de référence invalide',
  )
  .refine(
    (ref) => !ref.startsWith('/') && !ref.endsWith('/') && !ref.includes('//'),
    'Nom de référence invalide',
  )

export const gitCreateBranchBodySchema = z.object({
  name: gitRefSchema,
  /** Point de départ : une branche, un commit. HEAD par défaut. */
  from: z.union([gitRefSchema, commitHashSchema]).optional(),
  checkout: z.boolean().default(true),
})

export const gitCheckoutBodySchema = z.object({
  /** Une branche locale, une branche distante (`origin/x`), ou un commit. */
  ref: z.union([gitRefSchema, commitHashSchema]),
})

export const gitDeleteBranchBodySchema = z.object({
  name: gitRefSchema,
  /** `-D` : la branche part même si elle n'est pas fusionnée. Jamais implicite. */
  force: z.boolean().default(false),
})

export const gitMergeBodySchema = z.object({
  ref: z.union([gitRefSchema, commitHashSchema]),
})

export const gitPullBodySchema = z.object({
  /** Absent, git suit `pull.rebase` ; sinon la stratégie est imposée. */
  rebase: z.boolean().optional(),
})

export const gitPushBodySchema = z.object({
  /** `--force-with-lease`, et non `--force` : refuse d'écraser ce qu'on n'a pas vu. */
  force: z.boolean().default(false),
  /** Remote de publication quand la branche n'a pas encore d'amont. `origin` sinon. */
  remote: gitRefSchema.optional(),
})

export const gitStashBodySchema = z.object({
  message: z.string().trim().max(500).optional(),
  includeUntracked: z.boolean().default(true),
})

export const gitStashIndexBodySchema = z.object({
  index: z.number().int().min(0).max(10_000),
})

export const gitResetModeSchema = z.enum(['soft', 'mixed', 'hard'])
export type GitResetMode = z.infer<typeof gitResetModeSchema>

export const gitResetBodySchema = z.object({
  hash: commitHashSchema,
  mode: gitResetModeSchema,
})

export const gitRevertBodySchema = z.object({
  hash: commitHashSchema,
})
