import { z } from 'zod'
import { agentConfigSchema, type CodexMode } from './agent-config.js'
import { elicitationActionSchema, elicitationContentSchema } from './elicitation.js'
import { agentKindSchema, type AgentKind } from './events.js'

export const conversationStatusSchema = z.enum([
  'idle',
  'running',
  'awaiting_input',
  'interrupted',
  'error',
])
export type ConversationStatus = z.infer<typeof conversationStatusSchema>

export const projectVisibilitySchema = z.enum(['private', 'shared'])
export type ProjectVisibility = z.infer<typeof projectVisibilitySchema>

// Auth

export const loginBodySchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
})

export interface CurrentUser {
  id: string
  username: string
  displayName: string
  isAdmin: boolean
}

// Administration des comptes

const PASSWORD_MIN = 8

export const createUserBodySchema = z.object({
  username: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9._-]+$/i, 'Lettres, chiffres, point, tiret et souligné uniquement'),
  displayName: z.string().min(1).max(120),
  password: z.string().min(PASSWORD_MIN, `Au moins ${PASSWORD_MIN} caractères.`).max(256),
  isAdmin: z.boolean().default(false),
})

/** Même contrainte qu'à la création : l'identifiant sert de nom de connexion. */
const usernameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9._-]+$/i, 'Lettres, chiffres, point, tiret et souligné uniquement')

export const updateUserBodySchema = z
  .object({
    username: usernameSchema,
    displayName: z.string().min(1).max(120),
    isAdmin: z.boolean(),
    /**
     * Réinitialisation par un administrateur : déconnecte le compte partout.
     * Pour son propre compte, `currentPassword` est exigé et la session courante est
     * conservée.
     */
    password: z.string().min(PASSWORD_MIN, `Au moins ${PASSWORD_MIN} caractères.`).max(256),
    currentPassword: z.string().min(1).max(256),
  })
  .partial()

export interface UserDto {
  id: string
  username: string
  displayName: string
  isAdmin: boolean
  createdAt: number
  /** Sessions ouvertes : dit si le compte est réellement utilisé quelque part. */
  activeSessions: number
  /**
   * Ressources qui empêchent la suppression. Les clés étrangères de `users` ne sont
   * pas en cascade : effacer un compte qui possède des projets casserait la base.
   */
  ownedProjects: number
  ownedConversations: number
}

// Projets

export const createProjectBodySchema = z.object({
  name: z.string().min(1).max(120),
  workspacePath: z.string().min(1),
  visibility: projectVisibilitySchema.default('private'),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().default(null),
})

export const updateProjectBodySchema = z
  .object({
    name: z.string().min(1).max(120),
    /** Prend effet au prochain lancement de runner, pas sur ceux déjà en cours. */
    workspacePath: z.string().min(1),
    visibility: projectVisibilitySchema,
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(),
    defaultConfig: agentConfigSchema.nullable(),
    archived: z.boolean(),
  })
  .partial()

/** Ordre manuel des projets dans la sidebar, du haut vers le bas. */
export const reorderProjectsBodySchema = z.object({
  ids: z.array(z.string().uuid()).min(1),
})

export interface ProjectDto {
  id: string
  name: string
  workspacePath: string
  ownerId: string
  ownerName: string
  visibility: ProjectVisibility
  color: string | null
  isOwner: boolean
  position: number
  archivedAt: number | null
  createdAt: number
  conversationCount: number
  /** État du dépôt git, null si le workspace n'est pas un dépôt. */
  git: { branch: string; isDirty: boolean } | null
}

// Pièces jointes

export const MAX_ATTACHMENTS_PER_MESSAGE = 5

/**
 * Plafond des mentions d'un message. Chacune injecte un fichier entier dans le
 * contexte : au-delà, un message consomme la fenêtre à lui seul.
 */
export const MAX_MENTIONS_PER_MESSAGE = 20

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

/**
 * Types d'image que l'API Claude accepte en ligne. Le reste part comme fichier :
 * une image dans un format non listé serait refusée par le modèle.
 */
export const INLINE_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const

export interface AttachmentDto {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  createdAt: number
  /** Vrai si le fichier sera transmis au modèle comme image plutôt que comme chemin. */
  inlineImage: boolean
}

/**
 * Un message peut n'être que des pièces jointes, d'où le texte facultatif. En
 * revanche il doit porter au moins l'un des deux : sans ça, un envoi accidentel
 * créerait un tour vide auquel l'agent n'a rien à répondre.
 */
const messagePayloadSchema = z
  .object({
    /** Généré par le client, rejoué à l'identique en cas de renvoi réseau (I5). */
    clientMessageId: z.string().uuid(),
    text: z.string().default(''),
    attachmentIds: z.array(z.string().uuid()).max(MAX_ATTACHMENTS_PER_MESSAGE).default([]),
    /**
     * Chemins mentionnés avec `@`, relatifs au répertoire de travail, tels qu'ils
     * apparaissent dans le texte. Le serveur les résout en chemins absolus et chaque
     * CLI les transmet à sa façon.
     */
    mentions: z.array(z.string().min(1)).max(MAX_MENTIONS_PER_MESSAGE).default([]),
  })
  .refine(
    (body) => body.text.trim().length > 0 || body.attachmentIds.length > 0,
    'Un message vide et sans pièce jointe n\'a rien à envoyer.',
  )

// Conversations

export const createConversationBodySchema = z.object({
  agent: agentKindSchema,
  config: agentConfigSchema,
  worktreeId: z.string().nullable().default(null),
  title: z.string().min(1).max(200).optional(),
  /**
   * Premier message, envoyé dans la foulée de la création.
   *
   * L'UI ne crée pas de conversation tant que rien n'a été écrit : sans ça, chaque
   * clic laisse un fil vide et sans titre dans la liste. Passer le message ici rend
   * l'opération atomique, plutôt que de risquer une conversation créée dont l'envoi
   * échoue.
   */
  firstMessage: messagePayloadSchema.optional(),
})

/** Ordre manuel des conversations d'un projet, du haut vers le bas. */
export const reorderConversationsBodySchema = z.object({
  ids: z.array(z.string().uuid()).min(1),
})

export const updateConversationBodySchema = z
  .object({
    title: z.string().min(1).max(200),
    pinned: z.boolean(),
    archived: z.boolean(),
    /** Prend effet au message suivant : le runner est relancé en reprise. */
    config: agentConfigSchema,
  })
  .partial()

export const sendMessageBodySchema = messagePayloadSchema

/**
 * Infléchissement du tour en cours. Même charge utile qu'un envoi : c'est le même
 * message, seul son moment de prise en compte change.
 */
export const steerBodySchema = messagePayloadSchema

/**
 * Fork d'une conversation à un point du fil.
 *
 * `throughSeq` est le dernier événement du journal conservé dans la branche. La coupe
 * s'exprime en événements et non en tours, parce que c'est ce que le client voit ;
 * le serveur en déduit ce que chaque CLI attend.
 */
export const forkConversationBodySchema = z.object({
  throughSeq: z.number().int().nonnegative(),
  title: z.string().min(1).max(200).optional(),
})

export const permissionDecisionBodySchema = z.object({
  decision: z.enum(['allowed', 'denied']),
  scope: z.enum(['once', 'session', 'always']).default('once'),
})

/**
 * Réponse à une question posée par l'agent.
 *
 * Les valeurs sont libres et non contraintes aux options proposées : les deux CLI
 * acceptent une réponse « autre », saisie au clavier.
 */
export const questionAnswerBodySchema = z.object({
  status: z.enum(['answered', 'cancelled']),
  answers: z.record(z.string(), z.array(z.string())).default({}),
})

/**
 * Réponse à une élicitation MCP. Les valeurs ne sont validées ici que sur leur forme :
 * la conformité au schéma demandé est vérifiée par le serveur MCP lui-même, qui en est
 * l'auteur.
 */
export const elicitationAnswerBodySchema = z.object({
  action: elicitationActionSchema,
  content: elicitationContentSchema.default({}),
})

export const planDecisionBodySchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  /**
   * Comment poursuivre après validation : l'`id` d'une option annoncée par
   * `plan.review_requested`. Null laisse le mode courant en place. Opaque ici,
   * validé par l'adaptateur qui a proposé les options.
   */
  followUpMode: z.string().nullable().default(null),
})

export interface ConversationDto {
  id: string
  projectId: string
  worktreeId: string | null
  userId: string
  title: string
  /** Vrai si l'utilisateur a renommé : le CLI ne proposera plus de titre. */
  titleSetByUser: boolean
  agent: AgentKind
  /** Conversation d'origine si celle-ci est une branche. Null sinon. */
  forkedFromId: string | null
  config: unknown
  status: ConversationStatus
  lastSeq: number
  costUsd: number
  inputTokens: number
  outputTokens: number
  pinned: boolean
  position: number
  archivedAt: number | null
  createdAt: number
  updatedAt: number
  isOwner: boolean
}

export interface JournalPageDto {
  entries: { seq: number; ts: number; event: unknown }[]
  /** Dernier seq connu du serveur : sert de curseur d'abonnement au WebSocket. */
  lastSeq: number
}

// Worktrees

export const createWorktreeBodySchema = z.object({
  /** Nom de branche. Sert aussi de nom de dossier, d'où la restriction. */
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9._\/-]+$/, 'Caractères autorisés : lettres, chiffres, . _ - /')
    // Le nom sert aussi à construire un chemin sur disque : `..` doit être refusé
    // ici, et pas seulement par git qui ne le rejette que par effet de bord.
    .refine((name) => !name.split('/').includes('..'), 'Le nom ne peut pas contenir « .. »')
    .refine((name) => !name.startsWith('/') && !name.endsWith('/'), 'Nom de branche invalide'),
  baseRef: z.string().min(1).default('HEAD'),
})

export interface WorktreeDto {
  id: string
  projectId: string
  name: string
  path: string
  baseRef: string
  createdAt: number
  /** Null si le dossier a disparu du disque en dehors de Sillage. */
  git: { branch: string; isDirty: boolean } | null
  /** Nombre de conversations qui l'utilisent, pour prévenir avant suppression. */
  conversationCount: number
}

export interface DiffFileDto {
  path: string
  added: number
  removed: number
}

export interface WorkingDiffDto {
  /** Null si le répertoire de travail n'est pas un dépôt git. */
  files: DiffFileDto[] | null
  patch: string
  truncated: boolean
  cwd: string
  /** Branche courante, ou null hors dépôt. Le worktree, lui, est déjà connu du fil. */
  branch: string | null
  /**
   * Dernier commit, tel que `git log -1` le rend.
   *
   * Affiché parce qu'un diff vide a deux causes qu'on ne distingue pas autrement :
   * rien n'a été touché, ou l'agent vient de commiter ce qu'il a fait.
   */
  head: { hash: string; subject: string; relativeDate: string } | null
}

// Sessions Claude Code existantes sur le disque

/**
 * Une session commencée avec le CLI Claude Code dans le dossier du projet, pas encore
 * rattachée à une conversation Sillage. L'import n'en fait pas une copie : Sillage
 * retient l'identifiant natif et reconstruit son journal depuis le transcript, puis
 * chaque tour reprend la même session côté CLI.
 */
export interface ClaudeSessionDto {
  sessionId: string
  title: string
  firstPrompt: string | null
  gitBranch: string | null
  lastModified: number
}

export interface ClaudeSessionsDto {
  sessions: ClaudeSessionDto[]
}

/** Résultat d'une resynchronisation : nombre d'événements repris du transcript. */
export interface ClaudeSyncDto {
  imported: number
}

// Capacités des CLI

/** Un niveau d'effort accepté par un modèle. Le libellé vient de l'adaptateur. */
export interface AgentEffortDto {
  value: string
  label: string
  hint: string | null
}

/**
 * Un modèle tel que le CLI installé le déclare, sous une forme commune aux CLI.
 * Rien n'est codé en dur côté Sillage : une mise à jour du CLI fait apparaître ses
 * nouveaux modèles sans rebuild, et l'UI construit les mêmes sélecteurs pour tous.
 */
export interface AgentModelDto {
  /** Identifiant à passer au CLI : un alias (`sonnet`) ou un id complet. */
  value: string
  displayName: string
  description: string
  /** Complément affiché (id canonique derrière un alias...), quand le CLI le donne. */
  hint: string | null
  isDefault: boolean
  /** Vide si le modèle ne gère pas les niveaux d'effort. */
  efforts: AgentEffortDto[]
  /** Repli quand le niveau de la conversation n'existe pas sur ce modèle. */
  defaultEffort: string | null
}

/**
 * Nature du compte Claude, telle que le CLI la déclare.
 *
 * Elle décide de ce que l'UI a le droit d'afficher : sur un abonnement, le coût
 * calculé par le CLI est un équivalent API et ne correspond à aucune facturation.
 * C'est le quota qui décrit la ressource réellement consommée.
 */
export interface ClaudeAccountDto {
  /** Par exemple « Claude Max ». Null quand la facturation est à l'usage. */
  subscriptionType: string | null
  organization: string | null
  /** Vrai si un abonnement couvre l'usage, donc si afficher un montant tromperait. */
  billedBySubscription: boolean
}

/**
 * Un mode de collaboration proposé par Codex, tel que `collaborationMode/list` le
 * déclare. Le nom affiché vient du CLI : Sillage ne traduit pas « Plan » en autre chose.
 */
export interface CodexModeDto {
  mode: CodexMode
  label: string
}

/** Réponse de `/api/agents/:agent/models`, la même forme quel que soit le CLI. */
export interface AgentModelsDto {
  models: AgentModelDto[]
  /** Modes de collaboration (Codex) ; vide quand le CLI n'en annonce pas. */
  modes: CodexModeDto[]
  /** Nature du compte quand le CLI la déclare (Claude) ; null sinon. */
  account: ClaudeAccountDto | null
  fetchedAt: number
}

/**
 * Ce que Sillage trouve d'un CLI sur la machine, pour un agent donné.
 *
 * L'écran s'en sert pour ne pas proposer un agent que le serveur ne saurait pas lancer :
 * le CLI n'est plus embarqué dans la release, donc son absence est un état normal et
 * doit se lire, pas se découvrir à l'échec du premier tour.
 *
 * `version` peut être null sur un CLI pourtant présent : un binaire qui ne répond pas à
 * `--version` reste utilisable, et le dire introuvable serait faux.
 */
export interface AgentAvailabilityDto {
  agent: AgentKind
  /** Nom ou chemin déclaré en configuration, à montrer quand la résolution échoue. */
  binary: string
  /** Faux quand la configuration désactive l'agent : rien n'a alors été sondé. */
  enabled: boolean
  installed: boolean
  /** Vrai quand c'est Sillage qui l'a installé, faux quand il vient du PATH système. */
  managed: boolean
  /** Chemin absolu réellement lancé ; null quand introuvable. */
  path: string | null
  version: string | null
  /** Pourquoi l'agent est indisponible ; null quand il l'est. */
  reason: 'disabled' | 'not_on_path' | 'not_executable' | null
  /** Version que Sillage vise pour cette release, et que l'installation poserait. */
  preferredVersion: string
  install: CliInstallStateDto
}

/**
 * Installation en cours ou dernier échec, pour un agent.
 *
 * `idle` couvre aussi bien « jamais tenté » que « terminé » : une installation réussie
 * se lit dans `installed` et `version`, pas ici. Un état qui resterait « réussi » après
 * coup dirait la même chose deux fois, et pourrait la dire autrement.
 */
export type CliInstallStateDto =
  | { status: 'idle' }
  | { status: 'running'; version: string }
  | { status: 'failed'; version: string; error: string }

/** Réponse de `/api/agents`. */
export interface AgentAvailabilityListDto {
  agents: AgentAvailabilityDto[]
}

// Explorateur de dossiers

export const browseQuerySchema = z.object({
  path: z.string().optional(),
  showHidden: z.coerce.boolean().default(false),
})

export interface FsEntryDto {
  name: string
  path: string
  /** Le dossier contient un .git : utile pour repérer une racine de projet. */
  isGitRepo: boolean
  /** Lecture refusée : l'entrée est listée mais on ne peut pas y descendre. */
  readable: boolean
}

export interface FsListingDto {
  path: string
  /** null à la racine du système de fichiers. */
  parent: string | null
  entries: FsEntryDto[]
  isGitRepo: boolean
  /** Le listing a été tronqué : le dossier contient plus d'entrées que la limite. */
  truncated: boolean
  /** Points de départ proposés dans l'UI. */
  roots: { label: string; path: string }[]
}

// Notifications push

/**
 * Contenu d'une notification, tel que le service worker le reçoit.
 *
 * Volontairement minimal : le service worker n'a pas de session, il ne peut donc rien
 * aller relire. Tout ce qu'il affiche doit tenir ici.
 */
export interface PushPayload {
  title: string
  body: string
  /** Chemin à ouvrir au clic, relatif à l'origine. */
  url: string
  /**
   * Regroupe les notifications d'une même conversation : une seule reste affichée,
   * plutôt qu'une pile qui répète la même information.
   */
  tag: string
}

export const pushSubscribeBodySchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
})

export const pushUnsubscribeBodySchema = z.object({ endpoint: z.string().url() })

export interface PushStatusDto {
  /** Clé publique VAPID de l'instance, requise par le navigateur pour s'abonner. */
  publicKey: string
  /** Vrai si ce compte a déjà au moins un appareil abonné. */
  subscribed: boolean
}

// Explorateur de fichiers du panneau latéral

/**
 * État git d'une entrée. Sur un dossier, il est dérivé de ce qu'il contient : sans ça,
 * il faudrait tout déplier pour trouver ce qui a changé.
 */
export const fileStateSchema = z.enum([
  'modified',
  'added',
  'deleted',
  'untracked',
  'ignored',
])
export type FileState = z.infer<typeof fileStateSchema>

export const treeQuerySchema = z.object({
  /** Relatif au répertoire de travail. Vide pour la racine. */
  path: z.string().max(1024).default(''),
})

export interface TreeEntryDto {
  name: string
  /** Chemin relatif au répertoire de travail, seul identifiant utilisé par l'UI. */
  path: string
  isDirectory: boolean
  /** Absent quand le fichier est inchangé, ou quand le workspace n'est pas un dépôt. */
  state?: FileState
}

export interface TreeListingDto {
  path: string
  entries: TreeEntryDto[]
  /** Faux hors dépôt git : l'explorateur n'affiche alors aucune couleur. */
  versioned: boolean
}

export const treeSearchQuerySchema = z.object({
  q: z.string().min(1).max(200),
})

export interface TreeSearchDto {
  entries: TreeEntryDto[]
  /**
   * Vrai quand la marche s'est arrêtée avant d'avoir tout vu, faute de quoi une
   * recherche sur un gros dépôt afficherait « aucun résultat » là où il y en avait
   * simplement plus loin.
   */
  truncated: boolean
}

/**
 * Un nom d'entrée, et rien d'autre.
 *
 * Les séparateurs sont refusés ici plutôt que plus loin : un nom est un nom, et
 * laisser passer `../x` ferait reposer tout le bornage sur la seule normalisation de
 * chemin. `.` et `..` sont refusés pour la même raison.
 */
const entryNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((name) => !name.includes('/') && !name.includes('\\'), {
    message: 'Un nom ne peut pas contenir de séparateur de chemin.',
  })
  .refine((name) => name !== '.' && name !== '..', { message: 'Nom réservé.' })

export const createEntryBodySchema = z.object({
  /** Dossier parent, relatif au répertoire de travail. Vide pour la racine. */
  parent: z.string().max(1024).default(''),
  name: entryNameSchema,
  kind: z.enum(['file', 'directory']),
})

/**
 * Renommer et déplacer sont la même opération : seul le chemin de destination change.
 * En faire deux routes obligerait l'interface à décider laquelle appeler à partir du
 * chemin, ce que le serveur fait déjà mieux.
 */
export const moveEntryBodySchema = z.object({
  from: z.string().min(1).max(1024),
  to: z.string().min(1).max(1024),
})

export const deleteEntryBodySchema = z.object({ path: z.string().min(1).max(1024) })

// Fichiers du panneau

/** Au-delà, l'éditeur rame et le contenu ne se lit plus : refus explicite. */
export const MAX_EDITABLE_BYTES = 2 * 1024 * 1024

/**
 * Extensions rendues comme images plutôt que comme texte, et le type servi pour
 * chacune. Liste fermée et partagée : le serveur y lit le type à renvoyer, le client
 * y lit s'il doit afficher une image. Deviner d'après le contenu ferait rendre
 * n'importe quel binaire dans une balise `img`.
 */
export const VIEWABLE_IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  avif: 'image/avif',
}

export const filePathQuerySchema = z.object({ path: z.string().min(1).max(1024) })

/**
 * Chemins dont le fil demande s'ils désignent un fichier, pour n'en rendre cliquables
 * que ceux qui existent.
 *
 * Groupé par message : un message cite couramment une dizaine de chemins, et autant
 * d'allers-retours pour afficher un lien coûterait plus que le lien ne rapporte. Le
 * plafond suit `MAX_RESULTS` de la recherche de fichiers, pour la même raison.
 */
export const filesExistBodySchema = z.object({
  paths: z.array(z.string().min(1).max(1024)).max(50),
})

export interface FileContentDto {
  path: string
  content: string
  /**
   * Empreinte du fichier sur le disque au moment de la lecture (taille et date de
   * modification). Renvoyée à l'enregistrement : c'est elle qui détecte qu'un agent a
   * écrit dans le fichier entre-temps.
   */
  fingerprint: string
  /** Extension en minuscules, dont l'UI déduit le mode de coloration. */
  extension: string
}

export const fileWriteBodySchema = z.object({
  path: z.string().min(1).max(1024),
  content: z.string(),
  /**
   * Empreinte reçue à la lecture. `null` force l'écriture : c'est le choix explicite
   * d'écraser, pris après qu'un conflit a été montré.
   */
  fingerprint: z.string().nullable(),
})

// Modification d'un fichier par un appel d'outil

export const editDiffQuerySchema = z.object({ path: z.string().min(1).max(1024) })

/**
 * Ce qu'un appel d'outil a fait d'un fichier, reconstitué depuis le payload natif
 * conservé dans le journal.
 *
 * Trois formes, parce que les deux CLI n'en disent pas autant :
 * - `patch` : un diff unifié, complet côté Codex, limité à l'extrait remplacé côté
 *   Claude quand l'appel est une édition ponctuelle (`partial`) ;
 * - `content` : le contenu écrit, sans point de comparaison. Une écriture entière
 *   côté Claude ne dit pas ce qu'il y avait avant, et l'inventer serait pire ;
 * - `unavailable` : rien d'exploitable, avec la raison affichée plutôt qu'un vide.
 */
export interface EditDiffDto {
  path: string
  kind: 'patch' | 'content' | 'unavailable'
  patch: string
  content: string
  /** Vrai quand le diff ne couvre qu'un extrait : ses numéros de ligne y sont relatifs. */
  partial: boolean
  reason: string | null
}

// Recherche

/** Nombre de messages rapportés par requête : la palette n'en affiche pas plus. */
export const SEARCH_RESULT_LIMIT = 20

/** Sous ce nombre de caractères, la recherche de contenu n'est pas lancée. */
export const SEARCH_MIN_QUERY = 3

/**
 * Bornes d'un passage trouvé dans un extrait.
 *
 * L'extrait arrive avec les correspondances encadrées par deux caractères de contrôle
 * plutôt que par du balisage : rendre du HTML venu de la base demanderait de lui faire
 * confiance, alors que ces bornes se découpent en texte pur.
 */
export const SEARCH_MARK_OPEN = '\u0001'
export const SEARCH_MARK_CLOSE = '\u0002'

export interface SearchMessageDto {
  conversationId: string
  projectId: string
  conversationTitle: string
  agent: AgentKind
  /** Position du message dans le journal : c'est elle qui ouvre le fil au bon endroit. */
  seq: number
  role: 'user' | 'assistant'
  ts: number
  excerpt: string
}

// Erreurs

/** Toutes les erreurs d'API partagent cette forme, pour un affichage uniforme côté UI. */
export interface ApiError {
  error: {
    code: string
    message: string
  }
}
