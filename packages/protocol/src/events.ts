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

/**
 * Appel d'outil dont l'événement descend, quand il vient d'un sous-agent : c'est
 * l'appel qui a lancé ce sous-agent. Null pour tout ce que produit l'agent principal.
 *
 * Défaut à null plutôt que champ requis : le journal est rejoué indéfiniment (I2), et
 * les événements écrits avant l'ajout de ce champ doivent continuer à se relire.
 */
const parentToolCallIdSchema = z.string().nullable().default(null)

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

/**
 * Un travail qui continue en dehors du tour : workflow, sous-agent passé en fond,
 * commande lancée en tâche de fond, surveillance d'un service.
 *
 * `kind` reste une chaîne libre plutôt qu'une énumération : le CLI en ajoute au fil
 * des versions et retombe sur son discriminant brut pour ceux qu'il ne nomme pas.
 * L'UI traduit ceux qu'elle connaît et affiche les autres tels quels, au lieu de
 * refuser un événement dont le seul tort serait d'être récent.
 */
export const backgroundTaskSchema = z.object({
  id: z.string(),
  kind: z.string(),
  description: z.string(),
})
export type BackgroundTask = z.infer<typeof backgroundTaskSchema>

/**
 * Une tâche planifiée qui rouvrira la session d'elle-même : `/loop`, qu'il tourne à
 * intervalle fixe ou à cadence choisie par l'agent. Les deux passent par le même
 * registre côté CLI, le second s'y inscrivant comme tâche à tir unique réarmée à
 * chaque tour.
 *
 * `schedule` est une expression cron à cinq champs, interprétée dans le fuseau du
 * serveur. Elle ne donne pas la date du prochain tir : le CLI ajoute une gigue qui va
 * jusqu'à la moitié de l'intervalle, donc l'affichage montre la cadence et le dernier
 * réveil observé plutôt qu'un compte à rebours qui mentirait.
 *
 * `prompt` est tronqué à 1000 caractères par le CLI, avec un marqueur en fin de chaîne.
 */
export const loopSchema = z.object({
  id: z.string(),
  schedule: z.string(),
  recurring: z.boolean(),
  prompt: z.string(),
})
export type Loop = z.infer<typeof loopSchema>

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
    parentToolCallId: parentToolCallIdSchema,
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
    parentToolCallId: parentToolCallIdSchema,
  }),
  z.object({
    type: z.literal('thinking.delta'),
    messageId: z.string(),
    text: z.string(),
    parentToolCallId: parentToolCallIdSchema,
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

  /**
   * Les travaux de fond vivants ont changé : un workflow a démarré, une commande
   * lancée en tâche de fond s'est terminée, un sous-agent est passé en arrière-plan.
   *
   * Sémantique de remplacement, et non d'incrément : chaque événement porte la liste
   * complète, l'état d'affichage se remplace au lieu de s'apparier. C'est ce qui
   * distingue ce travail-là du reste du journal, où un début et une fin se répondent.
   * Un événement manqué ne peut donc pas laisser un indicateur allumé pour toujours.
   *
   * Sans ça, un workflow tourne pendant plusieurs minutes sans que rien ne l'affiche :
   * le tour se termine, le fil passe au repos, et des fichiers changent sous les yeux
   * de l'utilisateur dans une session qui se dit inactive.
   */
  z.object({
    type: z.literal('background.updated'),
    tasks: z.array(backgroundTaskSchema),
  }),

  /**
   * Les boucles armées pour cette session, relevées à la fin de chaque tour.
   *
   * Même sémantique de remplacement que `background.updated`, et pour une raison plus
   * forte encore : le CLI n'annonce ni la création ni la fin d'une boucle, il répond
   * seulement quand on lui demande la liste. Une boucle expirée disparaît donc sans
   * rien émettre, et seul le relevé suivant la fait tomber.
   *
   * Sans ça une conversation qui se réveille toute seule est indiscernable d'une
   * conversation terminée, et le tour qu'elle ouvre s'affiche comme si l'utilisateur
   * l'avait écrit.
   */
  z.object({
    type: z.literal('loops.updated'),
    loops: z.array(loopSchema),
  }),

  /**
   * Une consigne est entrée dans la session sans que Sillage l'ait envoyée : le CLI l'a
   * réinjectée lui-même, une boucle arrivée à échéance étant le cas courant.
   *
   * Reconnue à ce que le CLI la livre en texte, là où les messages de Sillage sont
   * toujours des blocs et ceux du CLI des résultats d'outils. C'est ce que compte le
   * nombre d'itérations d'une boucle, faute de compteur côté CLI.
   */
  z.object({
    type: z.literal('prompt.injected'),
    text: z.string(),
  }),

  /**
   * Un travail vient d'être enregistré par le CLI.
   *
   * Complète la liste de niveau sur un point qu'elle ne porte pas : l'appel d'outil
   * d'où vient le travail. C'est lui qui permet de distinguer un sous-agent que le fil
   * suit déjà d'un travail que plus personne ne regarde, les deux étant annoncés dans
   * la même liste.
   */
  z.object({
    type: z.literal('task.started'),
    taskId: z.string(),
    /** Nul pour un travail que le harnais lance de lui-même, sans passer par un outil. */
    toolCallId: z.string().nullable().default(null),
    kind: z.string(),
    description: z.string(),
  }),

  /**
   * Un travail a avancé.
   *
   * Émis à chaque appel d'outil du travail, ce qui suffit à le décrire : un agent qui
   * n'appelle rien est en train de réfléchir, et le dernier outil reste alors ce qu'on
   * peut dire de plus juste sur ce qu'il fait.
   *
   * `activity` est la description que le CLI donne du moment présent, pas un cumul :
   * chaque événement remplace le précédent.
   */
  z.object({
    type: z.literal('task.progress'),
    taskId: z.string(),
    activity: z.string(),
    lastTool: z.string().nullable().default(null),
    toolUses: z.number(),
    totalTokens: z.number(),
    durationMs: z.number(),
  }),

  /**
   * Un travail s'est arrêté, avec ce qu'il en reste.
   *
   * `summary` est le compte rendu du CLI. Pour un travail que le fil suivait, il
   * double le résultat de l'appel d'outil ; pour un travail de fond, c'est la seule
   * réponse à « qu'a-t-il fait pendant ce temps », la liste de niveau se contentant
   * de le retirer.
   */
  z.object({
    type: z.literal('task.completed'),
    taskId: z.string(),
    status: z.enum(['completed', 'failed', 'stopped']),
    summary: z.string(),
    durationMs: z.number().nullable().default(null),
    /** Travail d'entretien, que le CLI demande de ne pas montrer dans le fil. */
    ambient: z.boolean().default(false),
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
