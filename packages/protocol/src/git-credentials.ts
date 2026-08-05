import { z } from 'zod'

/**
 * Accès aux forges git, par utilisateur et par hôte.
 *
 * Comme les secrets, un jeton s'écrit et ne se relit jamais par l'API. Contrairement à
 * eux, il appartient à un compte et non à l'instance : cloner un dépôt privé est un
 * geste d'utilisateur, alors que les secrets sont réservés aux administrateurs.
 *
 * Le jeton ne sert pas qu'au clone. Il est aussi ce qui rend possible le `push` d'un
 * agent, par un helper que Sillage inscrit dans le dépôt cloné.
 */

/** Hôte seul, tel que git le présentera au helper : ni schéma, ni port, ni chemin. */
export const gitHostSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9.-]+$/, 'Un nom d\'hôte seul, sans schéma ni port.')

export const gitCredentialSchema = z.object({
  host: z.string(),
  /**
   * Ce que le helper présentera comme nom d'utilisateur.
   *
   * Les forges n'attendent pas la même chose : GitHub ignore la valeur pour un jeton
   * personnel mais impose `x-access-token` pour un jeton d'installation, GitLab veut
   * `oauth2`. Le stocker évite de coder en dur une table de correspondance par forge.
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

/** Une entrée de la combobox de sélection de dépôt. */
export interface GitRepoDto {
  /** `owner/repo`, tel que la forge le nomme. */
  fullName: string
  /** Le nom seul, proposé comme nom de projet. */
  name: string
  cloneUrl: string
  isPrivate: boolean
  description: string | null
  /** Dernier push, pour classer les plus vivants en tête. */
  pushedAt: number | null
}

export interface GitRepoListDto {
  repos: GitRepoDto[]
  /** Vrai quand la forge a plus de dépôts que Sillage n'en a rapatriés. */
  truncated: boolean
}

export const startCloneBodySchema = z.object({
  url: z.string().min(1).max(2048),
  name: z.string().min(1).max(120),
  /** Dossier qui accueillera le clone ; le dépôt y crée son propre sous-dossier. */
  parentDir: z.string().min(1),
  /** Nom du sous-dossier, par défaut celui que git aurait choisi. */
  directory: z.string().min(1).max(255),
  visibility: z.enum(['private', 'shared']).default('private'),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .default(null),
})

export interface CloneJobDto {
  id: string
  status: 'running' | 'done' | 'failed'
  /** La phase telle que git la nomme, vide tant qu'il n'a rien dit. */
  phase: string
  percent: number | null
  /** Renseigné à la réussite : le projet créé dans la foulée du clone. */
  projectId: string | null
  /**
   * Même forme qu'une erreur d'API : un code que le client traduit, et un message
   * anglais de repli. Les échecs que Sillage ne sait pas nommer portent le texte brut
   * de git, qui reste plus précis que ne le serait une reformulation.
   */
  error: { code: string; message: string } | null
}

export interface RemoteUrl {
  /**
   * L'URL débarrassée de sa requête et de son fragment, et c'est elle qu'il faut
   * cloner : git suit l'adresse au caractère près et échouerait sur un `?ref=x` que la
   * validation aurait pourtant laissé passer.
   */
  url: string
  /** Hôte seul, minuscule, sans port : la clé des credentials. */
  host: string
  /** Dernier segment du chemin, sans `.git` : le nom de dossier que git choisirait. */
  repo: string
  isSsh: boolean
}

/** Schéma, identifiants facultatifs, hôte, port facultatif, puis chemin. */
const SCHEME_URL = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^:/?#]+)(?::\d+)?(\/.*)?$/i

/** Forme scp : pas de schéma, et un deux-points qui sépare l'hôte du chemin. */
const SCP_URL = /^(?:[^@/]+@)?([^:/]+):(.+)$/

/**
 * Découpe une URL de dépôt, dans les deux formes que les forges proposent au
 * copier-coller : `https://github.com/owner/repo.git` et `git@github.com:owner/repo.git`.
 *
 * Par motif et non par `new URL` : ce paquet est partagé entre le serveur et le
 * navigateur et ne déclare aucun global de runtime, ni DOM ni Node.
 *
 * Retourne null sur tout le reste, y compris un chemin local. C'est volontaire : le
 * clone d'un dépôt local n'a rien à faire dans un formulaire qui demande une URL, et le
 * refuser ici évite d'avoir à valider un chemin arbitraire plus loin.
 */
export function parseRemoteUrl(input: string): RemoteUrl | null {
  // Requête et fragment retirés d'emblée : une URL de dépôt n'en porte pas, mais une
  // adresse copiée depuis un navigateur en traîne souvent une.
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
  // Un nom de dépôt sert de nom de dossier : refuser ce qui remonterait l'arborescence.
  return name && name !== '.' && name !== '..' ? name : null
}
