import type {
  AgentConfig,
  ConversationStatus,
  ElicitationAction,
  ElicitationValue,
  SillageEvent,
} from '@sillage/protocol'
import type { ResolvedMcpServers } from './mcp-registry.js'

export interface PermissionDecision {
  decision: 'allowed' | 'denied'
  scope: 'once' | 'session' | 'always'
  decidedBy: string | null
}

/** Réponse de l'utilisateur à une question posée par l'agent. */
export interface QuestionAnswer {
  status: 'answered' | 'cancelled'
  /** Valeurs retenues par identifiant de question. */
  answers: Record<string, string[]>
  decidedBy: string | null
}

/** Réponse de l'utilisateur à une élicitation MCP. */
export interface ElicitationAnswer {
  action: ElicitationAction
  /** Valeurs saisies, vides sur un refus ou une annulation. */
  content: Record<string, ElicitationValue>
  decidedBy: string | null
}

/** Verdict de l'utilisateur sur un plan proposé par l'agent. */
export interface PlanReview {
  decision: 'approved' | 'rejected'
  /**
   * Suite retenue quand le plan est accepté : l'`id` d'une option que l'adaptateur a
   * proposées dans `plan.review_requested`. Opaque ici, validé par l'adaptateur.
   */
  followUpMode: string | null
  decidedBy: string | null
}

/** Ce que le gestionnaire de sessions fournit à un runner pour qu'il s'exprime. */
export interface RunnerContext {
  conversationId: string
  cwd: string
  config: AgentConfig
  /**
   * Exécutable du CLI, déjà résolu en chemin absolu quand il a pu l'être.
   *
   * Ne jamais le re-résoudre ni réécrire en dur le nom du binaire dans un runner : sous
   * systemd le PATH est minimal, et la résolution tient compte du préfixe où Sillage
   * installe les CLI qu'il gère, que `spawn` ne connaît pas. Reste le nom configuré
   * quand rien n'a été trouvé, pour que l'échec porte le nom demandé.
   */
  binary: string
  /** Racine de stockage des pièces jointes, à autoriser en lecture pour l'agent. */
  attachmentsRoot: string
  /**
   * Résout la configuration d'une conversation en serveurs MCP : les identifiants du
   * registre qu'elle active, moins les désactivés et les disparus, plus le serveur que
   * Sillage monte lui-même.
   *
   * Prend la configuration entière et non la seule liste d'identifiants, parce que le
   * serveur de Sillage n'en a pas : il dépend de `sillageMcp` et de `strictMcp`, qui
   * changent à chaud comme le reste.
   *
   * Fonction et non tableau figé : Codex doit rejouer la liste à chaque reprise de
   * thread, et Claude peut la remplacer à chaud. Un instantané pris au lancement
   * mentirait dans les deux cas.
   */
  resolveMcpServers(config: AgentConfig): ResolvedMcpServers
  /**
   * Ce qui se passe sur le projet, à injecter au démarrage de la session. Null quand il
   * n'y a rien à dire, ou que l'utilisateur a coupé les apports de Sillage.
   *
   * Le seul élément de contexte qui arrive sans que l'agent l'ait demandé : les outils
   * du serveur MCP répondent quand on les interroge, encore faut-il y penser.
   */
  projectOverview(config: AgentConfig): string | null
  /** Identifiant de session natif à reprendre, null pour une nouvelle session. */
  resumeSessionId: string | null
  /** Écrit dans le journal puis diffuse. `raw` conserve le message natif du CLI. */
  emit(event: SillageEvent, raw?: unknown): void
  setStatus(status: ConversationStatus): void
  /** Mémorise l'identifiant natif dès que le CLI l'annonce, pour pouvoir reprendre. */
  setAgentSessionId(sessionId: string): void
  /**
   * Persiste une configuration que la session vient de changer d'elle-même (mode de
   * permission adopté à l'approbation d'un plan, par exemple). Sans cette écriture,
   * l'UI de réglages et la prochaine reprise repartiraient de l'ancienne valeur.
   */
  updateConfig(config: AgentConfig): void
  /** Enregistre une demande de permission en attente et retourne son identifiant. */
  openPermissionRequest(toolName: string, input: unknown): string
  closePermissionRequest(requestId: string, decision: PermissionDecision): void
}

/** Une pièce jointe telle que le runner doit la transmettre au CLI. */
export interface OutgoingAttachment {
  id: string
  filename: string
  mimeType: string
  sizeBytes: number
  /** Chemin absolu sur le disque du serveur. */
  path: string
  /** Image d'un format que le modèle accepte en ligne. Sinon, seul le chemin part. */
  inlineImage: boolean
}

/**
 * Un fichier mentionné avec `@`, résolu par le serveur.
 *
 * Les deux CLI l'injectent différemment : Claude développe lui-même le `@chemin`
 * resté dans le texte, Codex attend un élément d'entrée `mention` à part. C'est cette
 * divergence qui justifie de faire voyager la mention à côté du texte plutôt que de
 * la laisser au seul soin de l'un des deux.
 */
export interface OutgoingMention {
  /** Chemin relatif au répertoire de travail, tel qu'écrit dans le message. */
  relativePath: string
  /** Chemin absolu sur le disque du serveur. */
  path: string
  name: string
}

/**
 * Contrat commun aux CLI (invariant I3). Le reste du serveur ne connaît que cette
 * interface : ajouter un CLI, c'est écrire une implémentation, sans toucher aux
 * routes, au journal, ni au frontend.
 */
export interface AgentRunner {
  readonly conversationId: string
  /**
   * La configuration sous laquelle la session tourne réellement, qui n'est pas toujours
   * celle enregistrée en base.
   *
   * Un réglage que le CLI refuse de changer à chaud reste celui du lancement jusqu'au
   * redémarrage, alors que la valeur demandée est déjà persistée et affichée. Sans cet
   * accès, rien ne permet de dire à l'utilisateur sous quel régime son tour se déroule.
   */
  readonly appliedConfig: AgentConfig
  /** Démarre le process et commence à traduire son flux vers le journal. */
  start(): Promise<void>
  send(
    text: string,
    attachments: OutgoingAttachment[],
    mentions: OutgoingMention[],
  ): Promise<void>
  /**
   * Applique une nouvelle configuration à la session en cours, sans la redémarrer.
   * Retourne false si le CLI ne sait pas changer ce réglage à chaud : l'appelant doit
   * alors arrêter le runner, qui repartira en reprise avec la nouvelle valeur.
   */
  applyConfig(config: AgentConfig): Promise<boolean>
  /**
   * Titre que le CLI a dérivé de la conversation, ou null s'il n'en propose pas.
   * Sert de titre par défaut à la place d'un « Nouvelle conversation » sans valeur.
   */
  suggestedTitle(): Promise<string | null>
  interrupt(): Promise<void>
  /** Répond à une demande de permission en attente. false si elle n'existe plus. */
  resolvePermission(requestId: string, decision: PermissionDecision): boolean
  /** Répond à une question posée par l'agent. false si elle n'est plus en attente. */
  answerQuestion(requestId: string, answer: QuestionAnswer): boolean
  /** Répond à une élicitation MCP. false si elle n'est plus en attente. */
  resolveElicitation(requestId: string, answer: ElicitationAnswer): boolean
  /**
   * Infléchit le tour en cours : le message est pris en compte immédiatement, sans
   * interrompre ni ouvrir un nouveau tour.
   *
   * Retourne false quand le CLI ne sait pas le faire, ou qu'aucun tour n'est en cours.
   */
  steer(text: string, attachments: OutgoingAttachment[], mentions: OutgoingMention[]): Promise<boolean>
  /**
   * Compacte le contexte : l'agent résume la conversation pour libérer de la place.
   *
   * Retourne false si le CLI ne sait pas le faire. Les deux CLI y arrivent, mais par
   * des chemins différents, d'où la présence de cette méthode plutôt qu'un appel direct.
   */
  compact(): Promise<boolean>
  /**
   * Statue sur un plan proposé par l'agent. false si la demande n'est plus en attente,
   * ou si le CLI ne connaît pas cette étape.
   */
  reviewPlan(requestId: string, review: PlanReview): boolean
  stop(): Promise<void>
}
