import { z } from 'zod'
import { instructionsModeSchema } from './instructions.js'

/**
 * Git forge access per user and host.
 *
 * Like secrets, tokens are write-only through the API. Unlike secrets, they belong to an
 * account rather than the instance: cloning a private repository is a user action, while
 * secrets are admin-only.
 *
 * The token is also used for agent `push` operations through a helper Sillage registers in the
 * cloned repository.
 */

/** Host only, as git presents it to the helper: no scheme, port or path. */
export const gitHostSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9.-]+$/, 'Un nom d\'hôte seul, sans schéma ni port.')

export const gitCredentialSchema = z.object({
  host: z.string(),
  /**
   * Username presented by the helper.
   *
   * Forges expect different values: GitHub ignores it for personal tokens but requires
   * `x-access-token` for installation tokens; GitLab expects `oauth2`. Storing it avoids a
   * hardcoded per-forge mapping.
   */
  username: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type GitCredential = z.infer<typeof gitCredentialSchema>

export const putGitCredentialBodySchema = z.object({
  host: gitHostSchema,
  username: z.string().min(1).max(120).default('x-access-token'),
  token: z.string().min(1),
})

export interface GitCredentialListDto {
  credentials: GitCredential[]
}

/** An entry in the repository-selection combobox. */
export interface GitRepoDto {
  /** `owner/repo`, as named by the forge. */
  fullName: string
  /** Name alone, suggested as the project name. */
  name: string
  cloneUrl: string
  isPrivate: boolean
  description: string | null
  /** Latest push time, to rank the most active repositories first. */
  pushedAt: number | null
}

export interface GitRepoListDto {
  repos: GitRepoDto[]
  /** True when the forge has more repositories than Sillage fetched. */
  truncated: boolean
}

export const startCloneBodySchema = z.object({
  url: z.string().min(1).max(2048),
  name: z.string().min(1).max(120),
  /** Clone destination directory; the repository creates its own subdirectory there. */
  parentDir: z.string().min(1),
  /** Subdirectory name, defaulting to the name git would choose. */
  directory: z.string().min(1).max(255),
  visibility: z.enum(['private', 'shared']).default('private'),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .default(null),
  /** Absent: infer from the cloned repository, as for an existing directory. */
  instructionsMode: instructionsModeSchema.optional(),
})

export interface CloneJobDto {
  id: string
  status: 'running' | 'done' | 'failed'
  /** Phase as named by git; empty until it reports one. */
  phase: string
  percent: number | null
  /** Set on success: project created immediately after cloning. */
  projectId: string | null
  /**
   * Same shape as API errors: a client-translated code and English fallback message. Unknown
   * failures retain raw git text, more precise than a paraphrase.
   */
  error: { code: string; message: string } | null
}

export interface RemoteUrl {
  /**
   * URL with query and fragment removed, used for cloning: git follows addresses exactly and
   * would fail on a `?ref=x` that validation had allowed.
   */
  url: string
  /** Lowercase host without port: the credential key. */
  host: string
  /** Last path segment without `.git`: the directory name git would choose. */
  repo: string
  isSsh: boolean
}

/** Scheme, optional credentials, host, optional port, then path. */
const SCHEME_URL = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^:/?#]+)(?::\d+)?(\/.*)?$/i

/** scp form: no scheme, with a colon separating host and path. */
const SCP_URL = /^(?:[^@/]+@)?([^:/]+):(.+)$/

/**
 * Parses a repository URL in the two forms offered by forges:
 * `https://github.com/owner/repo.git` and `git@github.com:owner/repo.git`.
 *
 * Uses patterns rather than `new URL`: this package is shared by server and browser and
 * declares no runtime globals, DOM or Node.
 *
 * Returns null for everything else, including local paths. Intentional: local clones do not
 * belong in a URL form; rejecting them here avoids validating arbitrary paths later.
 */
export function parseRemoteUrl(input: string): RemoteUrl | null {
  // Remove query and fragment immediately: repository URLs do not need them, but
  // addresses copied from a browser often include them.
  const url = input.trim().split(/[?#]/)[0]?.trim() ?? ''
  if (!url) return null

  const scheme = SCHEME_URL.exec(url)
  if (scheme) {
    const [, protocol = '', host = '', path = ''] = scheme
    if (!/^(https?|ssh)$/i.test(protocol)) return null

    const repo = lastSegment(path)
    if (!repo) return null
    return { url, host: host.toLowerCase(), repo, isSsh: protocol.toLowerCase() === 'ssh' }
  }

  if (url.includes('://')) return null

  const scp = SCP_URL.exec(url)
  if (!scp) return null

  const [, host = '', path = ''] = scp
  const repo = lastSegment(path)
  return repo ? { url, host: host.toLowerCase(), repo, isSsh: true } : null
}

function lastSegment(path: string): string | null {
  const segment = path.split('/').filter(Boolean).pop()
  if (!segment) return null
  const name = segment.replace(/\.git$/, '')
  // Repository names become directory names: reject values that traverse upwards.
  return name && name !== '.' && name !== '..' ? name : null
}
