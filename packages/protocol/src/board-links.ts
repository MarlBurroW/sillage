import { z } from 'zod'
import { agentConfigSchema, type AgentConfig } from './agent-config.js'
import { agentKindSchema } from './events.js'
import { DEFAULT_DECISION_HOURS, MAX_DECISION_HOURS } from './decisions.js'

/**
 * Un board relié à une source externe : les issues d'un dépôt GitHub y deviennent des
 * cartes, à côté des cartes locales, qui le restent.
 *
 * GitHub fait foi pour ce qui vient de lui (titre, description, état, commentaires) ;
 * Sillage n'y ajoute que ce qu'il est seul à savoir, les sessions et les notes locales.
 * Les nouvelles cartes restent locales, sauf si le board dit le contraire.
 *
 * La maintenance (sessions ouvertes par une issue ou un commentaire) ne décide rien à la
 * place de l'utilisateur : Sillage fournit le déclencheur, le contexte et la marque qui
 * reconnaît ce qu'il a publié ; ce que fait l'agent, et comment il répond, vient des
 * instructions écrites ici.
 */

export const MAX_BOARD_LABEL_CHARS = 50
export const MAX_BOARD_INSTRUCTIONS_CHARS = 8000
export const MAX_BOARD_SIGNATURE_CHARS = 300
export const MAX_BOARD_SESSIONS_PER_HOUR = 100

/** `owner/nom`, comme GitHub l'écrit. */
export const githubRepoSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, { message: 'A GitHub repository, as owner/name.' })

export const boardNewCardsSchema = z.enum(['local', 'github'])
export type BoardNewCards = z.infer<typeof boardNewCardsSchema>

/**
 * Qui parle sur GitHub : `developer`, l'agent écrit comme le développeur, sans rien de
 * visible ; `ai`, chaque publication d'agent se termine par la signature choisie. La
 * marque de session, invisible, est posée dans les deux cas.
 */
export const boardIdentitySchema = z.enum(['developer', 'ai'])
export type BoardIdentity = z.infer<typeof boardIdentitySchema>

/** Un commentaire pendant que la session travaille : il attend la fin du tour, ou l'infléchit. */
export const boardCommentDeliverySchema = z.enum(['queue', 'steer'])
export type BoardCommentDelivery = z.infer<typeof boardCommentDeliverySchema>

/** Où travaille la session d'une issue : son worktree `issue-<n>`, ou l'arbre principal. */
export const boardWorkspaceSchema = z.enum(['worktree', 'root'])
export type BoardWorkspace = z.infer<typeof boardWorkspaceSchema>

const label = z.string().trim().max(MAX_BOARD_LABEL_CHARS)
const instructions = z.string().max(MAX_BOARD_INSTRUCTIONS_CHARS)

export const boardLinkSettingsSchema = z
  .object({
    repo: githubRepoSchema,
    /** Ne montrer que les issues qui portent ce label ; vide pour toutes. */
    labelFilter: label,
    /** Les issues fermées depuis moins de ce nombre de jours restent visibles. */
    closedDays: z.number().int().min(0).max(365),
    /** Où vont les cartes créées sur ce board, par une personne ou un agent. */
    newCards: boardNewCardsSchema,
    /** Label qui place une issue ouverte dans « en cours ». */
    progressLabel: label,
    /** Label qui place une issue ouverte dans « à vérifier ». */
    reviewLabel: label,

    /** Une issue ouverte sur GitHub, hors Sillage, ouvre une session sur sa carte. */
    onIssue: z.boolean(),
    issueInstructions: instructions,
    /** Un commentaire écrit sur GitHub, hors Sillage, arrive dans la session de son issue. */
    onComment: z.boolean(),
    commentInstructions: instructions,
    commentDelivery: boardCommentDeliverySchema,
    /** Ton, langue, ce qu'on promet : commun aux deux déclencheurs. */
    replyStyle: instructions,
    identity: boardIdentitySchema,
    signature: z.string().trim().max(MAX_BOARD_SIGNATURE_CHARS),
    /** CLI et réglages des sessions de maintenance ; null : ceux du projet pour ce CLI. */
    sessionAgent: agentKindSchema,
    sessionConfig: agentConfigSchema.nullable(),
    workspace: boardWorkspaceSchema,
    /**
     * Sessions ouvertes et commentaires transmis par heure, au plus. Ne sert que si une
     * publication échappe à la marque (un agent qui l'oublie avec `gh`) : la boucle
     * s'arrête là.
     */
    maxSessionsPerHour: z.number().int().min(1).max(MAX_BOARD_SESSIONS_PER_HOUR),
    /** Les sessions de maintenance peuvent demander une décision, attendue au plus ce délai. */
    decisionsEnabled: z.boolean(),
    decisionMaxHours: z.number().int().min(1).max(MAX_DECISION_HOURS),
  })
  .refine((settings) => settings.sessionConfig === null || settings.sessionConfig.agent === settings.sessionAgent, {
    message: 'The session settings belong to another CLI.',
    path: ['sessionConfig'],
  })
export type BoardLinkSettings = z.infer<typeof boardLinkSettingsSchema>

export const DEFAULT_BOARD_SIGNATURE = '_Written by an AI agent._'

export const DEFAULT_BOARD_LINK_SETTINGS: Omit<BoardLinkSettings, 'repo'> = {
  labelFilter: '',
  closedDays: 14,
  newCards: 'local',
  progressLabel: 'in progress',
  reviewLabel: 'review',
  onIssue: false,
  issueInstructions: '',
  onComment: false,
  commentInstructions: '',
  commentDelivery: 'queue',
  replyStyle: '',
  identity: 'ai',
  signature: DEFAULT_BOARD_SIGNATURE,
  sessionAgent: 'claude',
  sessionConfig: null as AgentConfig | null,
  workspace: 'worktree',
  maxSessionsPerHour: 10,
  decisionsEnabled: false,
  decisionMaxHours: DEFAULT_DECISION_HOURS,
}

export interface BoardLinkDto extends BoardLinkSettings {
  projectId: string
  provider: 'github'
  url: string
  /** Compte dont l'identifiant GitHub sert à lire et écrire, et qui possède les sessions. */
  userId: string
  userName: string
  /** Issues retirées du board à la main, que la synchronisation laisse de côté. */
  hiddenCount: number
  lastSyncedAt: number | null
  /** Code de la dernière erreur de synchronisation, traduit par l'interface. */
  lastError: string | null
  syncing: boolean
}

/** Ce que l'écran de liaison propose avant qu'un board soit relié. */
export interface BoardLinkStateDto {
  link: BoardLinkDto | null
  /** Dépôt déduit de l'`origin` du dépôt local, quand c'est GitHub. */
  suggestedRepo: string | null
  /** Le compte courant a un identifiant pour github.com : sans lui, rien ne se relie. */
  hasCredential: boolean
}
