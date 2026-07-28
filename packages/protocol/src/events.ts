import { z } from 'zod'
import { elicitationContentSchema, elicitationFieldSchema } from './elicitation.js'

/**
 * Schéma d'événements normalisé (invariant I3 de la spec).
 *
 * Chaque adaptateur de CLI traduit son flux natif vers ces événements. Le frontend
 * ne connaît que ce schéma et ignore quel CLI est derrière. Le payload natif brut est
 * conservé à part, dans la colonne `events.raw`, pour les renderers spécialisés.
 */

export const agentKindSchema = z.enum(['claude', 'codex'])
export type AgentKind = z.infer<typeof agentKindSchema>

export const planStatusSchema = z.enum(['pending', 'in_progress', 'completed'])

export const contentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('thinking'), text: z.string() }),
  z.object({ type: z.literal('image'), mimeType: z.string(), url: z.string() }),
  /**
   * Pièce jointe non affichable en ligne. Le chemin transmis à l'agent n'apparaît pas
   * ici : le fil montre le fichier, pas son emplacement sur le disque du serveur.
   */
  z.object({
    type: z.literal('file'),
    name: z.string(),
    mimeType: z.string(),
    sizeBytes: z.number(),
    url: z.string(),
  }),
  z.object({
    type: z.literal('tool_use'),
    toolCallId: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal('tool_result'),
    toolCallId: z.string(),
    output: z.unknown(),
    isError: z.boolean(),
  }),
])
export type ContentBlock = z.infer<typeof contentBlockSchema>

/** Une option proposée par le CLI dans une demande de permission. */
export const permissionOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  scope: z.enum(['once', 'session', 'always']),
  behavior: z.enum(['allow', 'deny']),
})
export type PermissionOption = z.infer<typeof permissionOptionSchema>

/** Un choix proposé pour une question posée par l'agent. */
export const questionOptionSchema = z.object({
  label: z.string(),
  description: z.string(),
  /** Aperçu facultatif : maquette, extrait de code, exemple de configuration. */
  preview: z.string().nullable().default(null),
})
export type QuestionOption = z.infer<typeof questionOptionSchema>

/**
 * Une question posée par l'agent, normalisée entre les deux CLI.
 *
 * Claude passe par l'outil `AskUserQuestion`, Codex par la requête
 * `item/tool/requestUserInput`. Les deux décrivent la même chose : un intitulé, des
 * options, et la façon d'y répondre.
 */
export const agentQuestionSchema = z.object({
  /** Clé de la réponse. Codex la fournit, Claude utilise l'intitulé lui-même. */
  id: z.string(),
  header: z.string(),
  question: z.string(),
  /** Plusieurs options peuvent être retenues à la fois. */
  multiSelect: z.boolean().default(false),
  /** Une réponse libre est acceptée en plus des options proposées. */
  allowOther: z.boolean().default(false),
  /** La saisie ne doit pas s'afficher en clair. */
  secret: z.boolean().default(false),
  /** Vide quand seule une réponse libre est attendue. */
  options: z.array(questionOptionSchema).default([]),
})
export type AgentQuestion = z.infer<typeof agentQuestionSchema>

/**
 * Une façon de poursuivre après validation d'un plan, proposée par l'adaptateur.
 *
 * Comme `permission.requested.suggestions` : c'est le CLI qui sait quels modes il
 * accepte ensuite, pas le schéma commun. `id` est opaque pour le journal et l'UI, et
 * n'a de sens que pour l'adaptateur qui l'a émis (un mode de permission chez Claude).
 */
export const planFollowUpOptionSchema = z.object({
  id: z.string(),
  label: z.string(),
  hint: z.string().default(''),
})
export type PlanFollowUpOption = z.infer<typeof planFollowUpOptionSchema>

export const sillageEventSchema = z.discriminatedUnion('type', [
  // Cycle de vie
  z.object({
    type: z.literal('session.started'),
    agent: agentKindSchema,
    agentSessionId: z.string(),
    model: z.string(),
    cwd: z.string(),
    tools: z.array(z.string()),
  }),
  z.object({
    type: z.literal('session.ended'),
    reason: z.enum(['completed', 'interrupted', 'error']),
  }),
  z.object({ type: z.literal('turn.started') }),
  z.object({
    type: z.literal('turn.completed'),
    stopReason: z.string(),
    costUsd: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    /**
     * L'essentiel du contexte d'un CLI transite par le cache : ne compter que
     * `inputTokens` donne un total sans rapport avec la consommation réelle (2 contre
     * 33 231 sur un tour observé). Défaut à 0 pour les événements journalisés avant
     * l'ajout de ces champs.
     */
    cacheCreationTokens: z.number().default(0),
    cacheReadTokens: z.number().default(0),
  }),

  // Contenu
  z.object({
    type: z.literal('message.started'),
    messageId: z.string(),
    role: z.enum(['user', 'assistant']),
  }),
  z.object({
    type: z.literal('message.delta'),
    messageId: z.string(),
    text: z.string(),
  }),
  /**
   * Un même `messageId` peut recevoir plusieurs `message.completed` successifs : les
   * CLI livrent un message assistant par morceaux (réflexion, puis appels d'outils).
   * Le fold de rendu ajoute les blocs à la suite, il ne les remplace pas.
   */
  z.object({
    type: z.literal('message.completed'),
    messageId: z.string(),
    role: z.enum(['user', 'assistant']),
    blocks: z.array(contentBlockSchema),
  }),
  z.object({
    type: z.literal('thinking.delta'),
    messageId: z.string(),
    text: z.string(),
  }),

  // Outils
  z.object({
    type: z.literal('tool.started'),
    toolCallId: z.string(),
    name: z.string(),
    input: z.unknown(),
    parentToolCallId: z.string().nullable(),
  }),
  z.object({
    type: z.literal('tool.output_delta'),
    toolCallId: z.string(),
    chunk: z.string(),
  }),
  z.object({
    type: z.literal('tool.completed'),
    toolCallId: z.string(),
    output: z.unknown(),
    isError: z.boolean(),
    durationMs: z.number(),
  }),

  // Interaction requise
  z.object({
    type: z.literal('permission.requested'),
    requestId: z.string(),
    toolName: z.string(),
    input: z.unknown(),
    suggestions: z.array(permissionOptionSchema),
    /**
     * Libellés rédigés par le CLI lui-même. Ils décrivent l'action bien mieux qu'une
     * phrase reconstruite depuis le nom de l'outil, qui ne sait rien du contexte
     * (chemin hors des dossiers autorisés, règle déclenchée, portée demandée).
     *
     * Nullables et facultatifs : le journal est rejoué indéfiniment (I2), et les
     * événements écrits avant l'ajout de ces champs doivent continuer à se relire.
     */
    title: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    displayName: z.string().nullable().optional(),
  }),
  z.object({
    type: z.literal('permission.resolved'),
    requestId: z.string(),
    decision: z.enum(['allowed', 'denied', 'expired']),
    scope: z.enum(['once', 'session', 'always']),
    decidedBy: z.string().nullable(),
  }),

  // Questions posées par l'agent
  z.object({
    type: z.literal('question.requested'),
    requestId: z.string(),
    questions: z.array(agentQuestionSchema),
  }),
  z.object({
    type: z.literal('question.resolved'),
    requestId: z.string(),
    status: z.enum(['answered', 'cancelled', 'expired']),
    /** Réponses retenues, par identifiant de question. */
    answers: z.record(z.string(), z.array(z.string())).default({}),
    decidedBy: z.string().nullable(),
  }),

  /**
   * Message écrit pendant qu'un tour est déjà en cours.
   *
   * Il n'est pas transmis au CLI tout de suite : poussé en cours de tour, il se mêle
   * au contexte du tour courant, ce qui a été observé sur le CLI installé (la réponse
   * au second message est sortie avant la fin du premier, puis une seconde fois). La
   * file vit donc côté serveur, et ces deux événements la rendent visible.
   */
  z.object({
    type: z.literal('message.queued'),
    queueId: z.string(),
    text: z.string(),
    /** Nombre de pièces jointes, pour l'afficher sans exposer leur contenu. */
    attachmentCount: z.number().default(0),
  }),
  z.object({
    type: z.literal('message.dequeued'),
    queueId: z.string(),
    /** `sent` : le message part au CLI et devient un message ordinaire du fil. */
    reason: z.enum(['sent', 'cancelled', 'expired']),
  }),

  // Saisie réclamée par un serveur MCP (elicitation/create)
  z.object({
    type: z.literal('elicitation.requested'),
    requestId: z.string(),
    /** Serveur MCP à l'origine de la demande, à afficher : il n'est pas de confiance. */
    serverName: z.string(),
    /**
     * `form` attend une saisie, `url` demande d'ouvrir une page (authentification).
     * Codex a un troisième mode, `openai/form`, normalisé ici comme un formulaire.
     */
    mode: z.enum(['form', 'url']),
    message: z.string(),
    /** Renseignée en mode `url` uniquement. */
    url: z.string().nullable().default(null),
    fields: z.array(elicitationFieldSchema).default([]),
    title: z.string().nullable().default(null),
  }),
  z.object({
    type: z.literal('elicitation.resolved'),
    requestId: z.string(),
    /** `expired` n'existe pas dans MCP : c'est la clôture d'une demande sans réponse. */
    status: z.enum(['accept', 'decline', 'cancel', 'expired']),
    content: elicitationContentSchema.default({}),
    decidedBy: z.string().nullable(),
  }),

  // Validation d'un plan avant passage à l'exécution
  z.object({
    type: z.literal('plan.review_requested'),
    requestId: z.string(),
    /** Le plan, en markdown, tel que l'agent le propose. */
    plan: z.string(),
    /**
     * Suites possibles après validation, fournies par l'adaptateur. Défaut vide pour
     * les événements journalisés avant l'ajout du champ : l'UI propose alors une
     * validation sans changement de mode.
     */
    followUpOptions: z.array(planFollowUpOptionSchema).default([]),
  }),
  z.object({
    type: z.literal('plan.review_resolved'),
    requestId: z.string(),
    decision: z.enum(['approved', 'rejected', 'expired']),
    /**
     * Suite adoptée quand le plan est accepté : l'`id` d'une option proposée. C'est ce
     * qui distingue « valide et poursuis en demandant » de « valide et laisse
     * écrire ». Chaîne opaque ici : c'est l'adaptateur émetteur qui la valide, le
     * schéma commun n'a pas à connaître les modes de permission d'un CLI.
     */
    followUpMode: z.string().nullable().default(null),
    decidedBy: z.string().nullable(),
  }),

  /**
   * Le résumé du contexte a commencé.
   *
   * Sans ce repère, une compaction se présente comme un tour ordinaire : l'agent
   * paraît réfléchir alors qu'il réécrit sa mémoire, ce qui peut durer bien plus
   * longtemps qu'une réponse et n'en produira aucune.
   *
   * Aucun des deux CLI n'annonce d'avancement chiffré : l'événement dit qu'une
   * compaction est en cours, et c'est tout ce qu'ils permettent d'affirmer.
   */
  z.object({ type: z.literal('context.compaction_started') }),

  /**
   * L'agent a modifié un fichier du workspace.
   *
   * Événement normalisé plutôt qu'une déduction côté client à partir des noms
   * d'outils : c'est exactement ce que l'invariant I3 impose, et les deux CLI le
   * disent différemment (outils `Write`/`Edit` chez Claude, items `fileChange` chez
   * Codex). L'historique des modifications devient ainsi dérivable du seul journal,
   * donc rejouable et identique pour les deux.
   *
   * `toolCallId` rattache la modification à l'appel qui l'a produite, pour que
   * l'historique puisse renvoyer au fil.
   */
  z.object({
    type: z.literal('file.edited'),
    toolCallId: z.string(),
    /** Relatif au répertoire de travail quand il en fait partie, absolu sinon. */
    path: z.string(),
    action: z.enum(['created', 'modified', 'deleted']),
  }),

  /**
   * Le contexte vient d'être résumé.
   *
   * Journalisé parce que rien d'autre ne le montre : le fil ne perd aucun message,
   * mais la mémoire de l'agent, elle, a changé. Sans ce repère, une réponse qui ignore
   * un détail donné plus haut paraît inexplicable.
   *
   * `preTokens` et `postTokens` sont nullables : Claude les fournit, l'item de Codex
   * ne porte qu'un identifiant. Inventer un chiffre serait pire que de ne pas
   * l'afficher.
   */
  z.object({
    type: z.literal('context.compacted'),
    trigger: z.enum(['manual', 'auto', 'unknown']),
    preTokens: z.number().nullable().default(null),
    postTokens: z.number().nullable().default(null),
  }),

  // Métadonnées
  z.object({
    type: z.literal('plan.updated'),
    items: z.array(z.object({ text: z.string(), status: planStatusSchema })),
  }),
  /**
   * `costUsd` est le coût API équivalent calculé par le CLI. Sur un compte par
   * abonnement il ne correspond à aucune facturation : c'est `rateLimit` qui décrit
   * la ressource réellement consommée. L'UI choisit lequel afficher selon le compte.
   */
  z.object({
    type: z.literal('usage.updated'),
    costUsd: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    /**
     * Les deux champs ci-dessous sont tolérants : le journal est rejoué indéfiniment
     * (invariant I2), donc un événement écrit avant l'ajout d'un champ doit continuer
     * à se relire. Sans ces défauts, un ancien `usage.updated` produisait un `NaN`.
     *
     * Occupation de la fenêtre de contexte. C'est la ressource qui décide quand une
     * conversation devra être compactée, indépendante du quota de facturation.
     */
    context: z
      .object({
        usedTokens: z.number(),
        maxTokens: z.number(),
        /** De 0 à 1, tel que le CLI le calcule quand il le fournit. */
        ratio: z.number(),
      })
      .nullable()
      .optional(),
    rateLimit: z
      .object({
        type: z.string(),
        status: z.enum(['allowed', 'allowed_warning', 'rejected']).default('allowed'),
        /** Part du quota consommée, de 0 à 1. Absente si le CLI ne la donne pas. */
        utilization: z.number().nullish().default(null),
        /**
         * Remise à zéro de la fenêtre, en millisecondes. Les événements anciens la
         * portent en secondes : tout horodatage sous 1e12 est antérieur à 2001, donc
         * nécessairement des secondes. La conversion est idempotente.
         */
        resetsAt: z
          .number()
          .nullish()
          .default(null)
          .transform((value) =>
            value === null || value === undefined ? null : value < 1e12 ? value * 1000 : value,
          ),
      })
      .nullable()
      .optional(),
  }),
  z.object({
    type: z.literal('diff.updated'),
    files: z.array(
      z.object({ path: z.string(), added: z.number(), removed: z.number() }),
    ),
  }),
  z.object({
    type: z.literal('error'),
    code: z.string(),
    message: z.string(),
    recoverable: z.boolean(),
  }),
])

export type SillageEvent = z.infer<typeof sillageEventSchema>
export type SillageEventType = SillageEvent['type']

/** Un événement tel qu'il sort du journal : le payload plus sa position et sa date. */
export interface JournalEntry {
  conversationId: string
  seq: number
  ts: number
  event: SillageEvent
}
