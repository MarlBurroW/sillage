import { z } from 'zod'
import { type ConversationStatus } from './api.js'
import { type AgentKind } from './events.js'

/**
 * Colonne du board, c'est-à-dire la position choisie d'une carte dans le workflow.
 *
 * Délibérément pas nommée `status` : ce mot désigne l'état d'exécution d'une
 * conversation, et confondre les deux est le piège central de ce chantier. Une carte
 * porte trois axes orthogonaux — la colonne, qui se décide ; l'activité, qui s'observe
 * sur les conversations rattachées et n'est jamais persistée ici ; l'état de merge, qui
 * se lit dans git. Seul le premier est un champ de la table.
 *
 * La liste est fermée : les colonnes personnalisables rendraient l'état illisible pour
 * les dérivations et pour les outils qui liront le board.
 */
export const cardColumnSchema = z.enum(['todo', 'in_progress', 'review', 'done', 'abandoned'])
export type CardColumn = z.infer<typeof cardColumnSchema>

/** Ordre d'affichage des colonnes, du backlog vers les sorties. */
export const CARD_COLUMNS: readonly CardColumn[] = [
  'todo',
  'in_progress',
  'review',
  'done',
  'abandoned',
]

/**
 * Colonnes de sortie, repliées par défaut sur le board : sans quoi un projet ancien
 * finit dominé par son cimetière.
 */
export const CARD_CLOSED_COLUMNS: readonly CardColumn[] = ['done', 'abandoned']

const TITLE_MAX = 200
const DESCRIPTION_MAX = 20_000

export const createCardBodySchema = z.object({
  title: z.string().min(1).max(TITLE_MAX),
  description: z.string().max(DESCRIPTION_MAX).default(''),
  column: cardColumnSchema.default('todo'),
})

export const updateCardBodySchema = z
  .object({
    title: z.string().min(1).max(TITLE_MAX),
    description: z.string().max(DESCRIPTION_MAX),
    column: cardColumnSchema,
  })
  .partial()

/**
 * Ordre des cartes, colonne par colonne, du haut vers le bas.
 *
 * Un déplacement touche une colonne quand il monte ou descend une carte, deux quand il
 * la change de colonne. Les deux sont donc écrites d'un seul geste : les envoyer
 * séparément laisserait une carte dupliquée ou absente entre les deux requêtes.
 */
export const reorderCardsBodySchema = z.object({
  columns: z
    .array(
      z.object({
        column: cardColumnSchema,
        ids: z.array(z.string().uuid()),
      }),
    )
    .min(1)
    .max(CARD_COLUMNS.length),
})

/** Une carte vue depuis une autre : de quoi rendre une puce `#12` sans second appel. */
export interface CardLinkDto {
  id: string
  number: number
  title: string
  column: CardColumn
}

/**
 * Une conversation rattachée, telle que la carte a besoin de la montrer.
 *
 * `status` est l'état au chargement, comme partout ailleurs : le flux de statuts du
 * WebSocket a le dernier mot côté client.
 */
export interface CardConversationDto {
  id: string
  title: string
  agent: AgentKind
  status: ConversationStatus
  costUsd: number
  worktreeId: string | null
  worktreeName: string | null
  archivedAt: number | null
  createdAt: number
}

const NOTE_MAX = 8_000

export const createCardNoteBodySchema = z.object({
  body: z.string().min(1).max(NOTE_MAX),
})

/**
 * Une note du fil d'une carte : ce qu'une session a fait, trouvé ou décidé.
 *
 * Ajoutée, jamais réécrite, et distincte de la description : celle-ci est l'énoncé du
 * travail, tenu par une personne ; les notes en sont l'historique, écrit surtout par
 * les agents.
 */
export interface CardNoteDto {
  id: string
  body: string
  createdAt: number
  /**
   * Qui l'a écrite. Une note d'agent porte sa conversation, pour qu'on puisse aller
   * lire le travail dont elle rend compte ; `null` quand la conversation a été
   * supprimée depuis, la note lui survivant.
   */
  author:
    | { kind: 'agent'; agent: AgentKind; conversationId: string | null; conversationTitle: string }
    | { kind: 'user'; name: string }
}

export interface CardDto {
  id: string
  projectId: string
  /** Numéro court, unique dans le projet, tel qu'il s'écrit après le `#`. */
  number: number
  title: string
  description: string
  column: CardColumn
  position: number
  createdBy: string
  createdByName: string
  createdAt: number
  updatedAt: number
  conversations: CardConversationDto[]
  /** Les notes ne voyagent pas avec la liste : le board n'en affiche que le compte. */
  noteCount: number
  /** Cartes que la description de celle-ci mentionne. */
  references: CardLinkDto[]
  /** Cartes dont la description mentionne celle-ci. */
  referencedBy: CardLinkDto[]
}

/**
 * Le `#` doit ouvrir un mot, comme le `@` des fichiers : sans cette contrainte, une
 * couleur hexadécimale ou une ancre d'URL passerait pour une référence.
 */
const CARD_REFERENCE = /(?:^|[^\w#])#(\d+)\b/g

/**
 * Numéros de cartes cités dans un texte, dédupliqués et dans l'ordre d'apparition.
 *
 * Partagé par le serveur, qui en tire les backlinks à l'enregistrement, et par le web,
 * qui en tire les puces cliquables. Deux analyseurs finiraient par diverger, et une
 * référence rendue d'un côté sans exister de l'autre est pire que pas de référence.
 */
export function parseCardReferences(text: string): number[] {
  const found: number[] = []
  for (const match of text.matchAll(CARD_REFERENCE)) {
    const number = Number(match[1])
    if (Number.isSafeInteger(number) && number > 0 && !found.includes(number)) {
      found.push(number)
    }
  }
  return found
}

/**
 * Nom de branche proposé pour la première session d'une carte.
 *
 * Le numéro passe devant pour que la branche se relie à sa carte au premier coup d'œil
 * dans `git branch`, où le titre seul ne dit pas d'où il vient.
 */
export function cardBranchName(number: number, title: string): string {
  const slug = title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return slug.length > 0 ? `feat/${number}-${slug}` : `feat/${number}`
}
