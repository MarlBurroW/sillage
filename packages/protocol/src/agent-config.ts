import { z } from 'zod'
import type { ModeKind } from '@sillage/codex-bindings'
import type { AskForApproval, SandboxMode } from '@sillage/codex-bindings/v2'

/**
 * Réglages d'une conversation, par CLI.
 *
 * Volontairement non unifiés : le mode de permission de Claude et le couple
 * approbation/sandbox de Codex sont des concepts différents. L'UI affiche le
 * vocabulaire natif de chaque CLI plutôt que d'inventer une abstraction qui mentirait.
 */

export const claudePermissionModeSchema = z.enum([
  'manual',
  'auto',
  'acceptEdits',
  'plan',
  'dontAsk',
  'bypassPermissions',
])
export type ClaudePermissionMode = z.infer<typeof claudePermissionModeSchema>

export const claudeEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max'])

/**
 * Monte le serveur MCP de Sillage, qui ouvre à l'agent l'historique du projet.
 *
 * Vrai par défaut : c'est ce que la plateforme apporte de plus qu'un lancement direct du
 * CLI. Décochable par conversation pour le sujet où cette mémoire n'aide pas, et
 * coupable pour l'instance entière dans `config.toml`. Commun aux deux CLI, le serveur
 * ne devant rien à l'un ni à l'autre.
 */
const sillageMcpSchema = z.boolean().default(true)

/**
 * Livre la bibliothèque de skills de Sillage, globale et du projet, à la session.
 *
 * Un seul interrupteur, pas un par skill : un skill qu'on n'invoque pas ne coûte que sa
 * description dans le contexte. Coupable pour l'instance dans `config.toml`. Côté
 * Claude, le changer relance la session, les plugins n'étant que des options de
 * lancement ; Codex l'applique à chaud.
 */
const skillLibrarySchema = z.boolean().default(true)

export const claudeConfigSchema = z.object({
  agent: z.literal('claude'),
  model: z.string(),
  effort: claudeEffortSchema,
  permissionMode: claudePermissionModeSchema,
  additionalDirectories: z.array(z.string()).default([]),
  /** Identifiants de serveurs du registre MCP actifs sur cette conversation. */
  mcpServers: z.array(z.string()).default([]),
  sillageMcp: sillageMcpSchema,
  skillLibrary: skillLibrarySchema,
  /**
   * Ignore les serveurs déclarés sur le disque du CLI (`~/.claude.json`, `.mcp.json`,
   * connecteurs claude.ai) pour ne garder que ceux de Sillage.
   *
   * Faux par défaut : activer l'isolation d'office ferait disparaître sans prévenir des
   * serveurs que l'utilisateur a déclarés lui-même. Propre à Claude, Codex n'ayant pas
   * d'équivalent : son `config.toml` et son `codex_apps` intégré restent de toute façon.
   */
  strictMcp: z.boolean().default(false),
  /**
   * Mode rapide de Claude Code : même modèle, réponses plus rapides, facturées à part.
   *
   * Sur un abonnement, l'usage part en crédits d'usage, hors quota du forfait, et le
   * premier tour en mode rapide repaie le contexte entier à ce tarif, une fois par
   * conversation : c'est un réglage à poser au départ plutôt qu'à bascule. Seuls
   * certains modèles le gèrent (`supportsFastMode` dans le catalogue) ; l'activer sur
   * un autre fait basculer le CLI sur Opus. C'est le SDK qui doit opter : un `/fast`
   * tapé dans une session headless répond « non disponible », relevé à la sonde.
   */
  fastMode: z.boolean().default(false),
  /**
   * Ultracode de Claude Code : effort `xhigh` et orchestration par workflows
   * multi-agents sur chaque tâche de fond, le coût en tokens n'étant plus une
   * contrainte. Le mot-clé « ultracode » dans un message n'en ouvre qu'un tour ; ce
   * réglage le tient pour toute la session. Propre à la session, jamais écrit dans les
   * fichiers du CLI, et réservé aux modèles qui gèrent `xhigh`.
   */
  ultracode: z.boolean().default(false),
  /**
   * Style de sortie du CLI (`Concise`, `Explanatory`…), parmi ceux que le catalogue
   * annonce. Vide pour laisser le style par défaut.
   */
  outputStyle: z.string().default(''),
  /**
   * Modèle conseiller (`/advisor`), que le modèle principal peut consulter en cours de
   * tâche. Vide pour ne pas en donner : chaque consultation est un appel de plus.
   */
  advisorModel: z.string().default(''),
  /**
   * Garde-fous d'une session que personne ne regarde, pensés pour l'API de tâches :
   * coût cumulé en dollars et nombre d'appels de modèle au-delà desquels le CLI
   * referme le tour en erreur (`error_max_budget_usd`, `error_max_turns`). Comptés par
   * process : une session relancée pour un réglage repart de zéro. `null` ne plafonne
   * rien, ce qui est le défaut d'une conversation humaine ; le composer ne les montre
   * pas.
   */
  maxBudgetUsd: z.number().positive().nullable().default(null),
  maxTurns: z.number().int().positive().nullable().default(null),
})
export type ClaudeConfig = z.infer<typeof claudeConfigSchema>

/**
 * Les valeurs Codex ci-dessous ne sont pas choisies par Sillage : elles doivent
 * refléter `@sillage/codex-bindings`, généré par le binaire installé. Les
 * assertions de type en fin de fichier échouent à la compilation si elles divergent,
 * ce qui rend impossible une recopie approximative comme celle qui traînait ici.
 */

/** Variante objet de `AskForApproval`, qui règle chaque garde-fou séparément. */
export const codexGranularApprovalSchema = z.object({
  granular: z.object({
    sandbox_approval: z.boolean(),
    rules: z.boolean(),
    skill_approval: z.boolean(),
    request_permissions: z.boolean(),
    mcp_elicitations: z.boolean(),
  }),
})

export const codexApprovalNameSchema = z.enum(['untrusted', 'on-request', 'never'])

export type CodexApprovalName = z.infer<typeof codexApprovalNameSchema>

/**
 * Fidèle au protocole : c'est ce schéma que l'assertion de dérive compare à
 * `AskForApproval` généré. Il ne doit accepter que ce que Codex accepte.
 */
export const codexApprovalSchema = z.union([
  codexApprovalNameSchema,
  codexGranularApprovalSchema,
])

/**
 * Ce que Sillage accepte dans une configuration de conversation : le protocole, plus
 * la sentinelle `CLI_DEFAULT`.
 *
 * `thread/start` et `turn/start` déclarent `approvalPolicy` nullable, et un null y
 * signifie « applique la politique configurée dans le CLI ». La sentinelle exprime
 * exactement cet état, au même titre que pour le modèle et l'effort.
 *
 * `on-failure`, déprécié de longue date, a disparu du protocole avec Codex 0.146. Les
 * conversations écrites avant le retrait le portent encore en base : elles se relisent
 * sur `on-request`, le plus proche, plutôt que de devenir illisibles.
 */
export const codexApprovalConfigSchema = z.preprocess(
  (value) => (value === 'on-failure' ? 'on-request' : value),
  z.union([z.literal(''), codexApprovalNameSchema, codexGranularApprovalSchema]),
)

export const codexSandboxSchema = z.enum([
  'read-only',
  'workspace-write',
  'danger-full-access',
])

/**
 * `ReasoningEffort` est une chaîne libre dans le protocole : les niveaux réellement
 * acceptés dépendent du modèle et sont annoncés par `model/list`
 * (`supportedReasoningEfforts`). Toute énumération figée ici serait une invention.
 */
export const codexEffortSchema = z.string()

/**
 * Mode de collaboration Codex, l'équivalent du mode Plan de Claude.
 *
 * Ce n'est pas une invention de Sillage : le mode est porté par `turn/start`, derrière
 * la capacité `experimentalApi`, et c'est lui qui décide des outils accessibles au
 * modèle. En `default`, `request_user_input` est refusé par le routeur du CLI, donc
 * l'agent ne peut pas poser de question à choix : il se rabat sur une liste écrite
 * dans sa réponse.
 */
export const codexModeSchema = z.enum(['plan', 'default'])
export type CodexMode = z.infer<typeof codexModeSchema>

export const codexConfigSchema = z.object({
  agent: z.literal('codex'),
  /** Vide signifie « modèle par défaut du CLI », résolu à la création. */
  model: z.string(),
  reasoningEffort: codexEffortSchema,
  collaborationMode: codexModeSchema.default('default'),
  askForApproval: codexApprovalConfigSchema,
  sandbox: codexSandboxSchema,
  webSearch: z.boolean().default(false),
  profile: z.string().nullable().default(null),
  additionalDirectories: z.array(z.string()).default([]),
  /** Identifiants de serveurs du registre MCP actifs sur cette conversation. */
  mcpServers: z.array(z.string()).default([]),
  sillageMcp: sillageMcpSchema,
  skillLibrary: skillLibrarySchema,
})
export type CodexConfig = z.infer<typeof codexConfigSchema>

/**
 * Règle d'opencode pour une famille d'outils : demander, laisser faire, refuser.
 *
 * La chaîne vide est la sentinelle `CLI_DEFAULT` : Sillage ne pose alors aucune règle
 * et celle de l'`opencode.json` de l'utilisateur s'applique (à défaut, opencode laisse
 * faire). Les valeurs sont celles de `PermissionActionConfig` dans l'OpenAPI.
 */
export const opencodePermissionSchema = z.enum(['', 'ask', 'allow', 'deny'])
export type OpencodePermission = z.infer<typeof opencodePermissionSchema>

/**
 * Les familles d'outils que Sillage règle. opencode en connaît d'autres (`read`,
 * `task`, `skill`…) : elles gardent la règle du CLI, les exposer toutes ferait un écran
 * de réglages que personne ne lit.
 */
export const opencodePermissionsSchema = z.object({
  edit: opencodePermissionSchema.default('ask'),
  bash: opencodePermissionSchema.default('ask'),
  webfetch: opencodePermissionSchema.default(''),
})
export type OpencodePermissions = z.infer<typeof opencodePermissionsSchema>

export const opencodeConfigSchema = z.object({
  agent: z.literal('opencode'),
  /** `fournisseur/modèle`, tel qu'opencode l'écrit. Vide : le défaut du CLI. */
  model: z.string(),
  /**
   * Variante du modèle (`low`, `high`, `max`…), l'équivalent de l'effort chez les deux
   * autres. Chaîne libre : chaque modèle annonce les siennes dans le catalogue.
   */
  variant: z.string().default(''),
  /**
   * Agent primaire d'opencode qui mène le tour : `build`, `plan`, ou un agent déclaré
   * par l'utilisateur. C'est le pendant du `collaborationMode` de Codex, à ceci près
   * que la liste est ouverte. Nommé ainsi parce que `agent` est déjà le discriminant.
   */
  primaryAgent: z.string().default('build'),
  permissions: opencodePermissionsSchema.default({}),
  additionalDirectories: z.array(z.string()).default([]),
  /** Identifiants de serveurs du registre MCP actifs sur cette conversation. */
  mcpServers: z.array(z.string()).default([]),
  sillageMcp: sillageMcpSchema,
  skillLibrary: skillLibrarySchema,
})
export type OpencodeConfig = z.infer<typeof opencodeConfigSchema>

export const agentConfigSchema = z.discriminatedUnion('agent', [
  claudeConfigSchema,
  codexConfigSchema,
  opencodeConfigSchema,
])
export type AgentConfig = z.infer<typeof agentConfigSchema>

/**
 * Chaîne vide = « laisser le CLI décider ». Le serveur la remplace par le modèle et
 * l'effort réellement annoncés par le CLI au moment de créer la conversation.
 *
 * Écrire ici un identifiant au jugé (`gpt-5-codex`, qui n'existe pas) donne une
 * conversation qui échoue au lancement, des mois après la faute.
 */
export const CLI_DEFAULT = ''

export const DEFAULT_CLAUDE_CONFIG: ClaudeConfig = {
  agent: 'claude',
  model: CLI_DEFAULT,
  effort: 'medium',
  permissionMode: 'manual',
  additionalDirectories: [],
  mcpServers: [],
  sillageMcp: true,
  skillLibrary: true,
  strictMcp: false,
  fastMode: false,
  ultracode: false,
  outputStyle: CLI_DEFAULT,
  advisorModel: CLI_DEFAULT,
  maxBudgetUsd: null,
  maxTurns: null,
}

export const DEFAULT_CODEX_CONFIG: CodexConfig = {
  agent: 'codex',
  model: CLI_DEFAULT,
  reasoningEffort: CLI_DEFAULT,
  askForApproval: 'on-request',
  collaborationMode: 'default',
  sandbox: 'workspace-write',
  webSearch: false,
  profile: null,
  additionalDirectories: [],
  mcpServers: [],
  sillageMcp: true,
  skillLibrary: true,
}

export const DEFAULT_OPENCODE_CONFIG: OpencodeConfig = {
  agent: 'opencode',
  model: CLI_DEFAULT,
  variant: CLI_DEFAULT,
  primaryAgent: 'build',
  // opencode laisse tout faire par défaut. Sillage part de « demander » pour ce qui
  // écrit ou exécute, comme le mode manuel de Claude et le `on-request` de Codex.
  permissions: { edit: 'ask', bash: 'ask', webfetch: CLI_DEFAULT },
  additionalDirectories: [],
  mcpServers: [],
  sillageMcp: true,
  skillLibrary: true,
}

/**
 * Garde-fou de compilation : si `pnpm codex:types` fait apparaître une nouvelle
 * variante d'approbation ou de sandbox, ces alias deviennent `never` et le typecheck
 * échoue. C'est ce qui empêche les schémas Zod ci-dessus de mentir sur le protocole.
 */
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false

/**
 * `false` et non `never` : `never extends true` est vrai, donc une assertion bâtie
 * sur `never` passerait toujours et ne servirait à rien.
 */
type AssertTrue<T extends true> = T

export type ApprovalMatchesProtocol = AssertTrue<
  Exactly<z.infer<typeof codexApprovalSchema>, AskForApproval>
>
export type SandboxMatchesProtocol = AssertTrue<
  Exactly<z.infer<typeof codexSandboxSchema>, SandboxMode>
>
export type ModeMatchesProtocol = AssertTrue<Exactly<z.infer<typeof codexModeSchema>, ModeKind>>

/**
 * Relit une configuration stockée en base.
 *
 * Passer par le schéma plutôt que par un cast : ses valeurs par défaut rattrapent les
 * conversations écrites avant l'ajout d'un réglage. Sans ça, le champ manquant partait
 * `undefined` au CLI, qui rejetait le tour, longtemps après la mise à jour qui l'a
 * introduit.
 */
export function parseAgentConfig(stored: string): AgentConfig {
  return agentConfigSchema.parse(JSON.parse(stored))
}

/**
 * Table plutôt que ternaire : un CLI ajouté à l'enum sans sa ligne ici ne compile
 * pas, là où le ternaire binaire lui aurait attribué les défauts Codex en silence.
 */
export const DEFAULT_CONFIGS: Record<AgentConfig['agent'], AgentConfig> = {
  claude: DEFAULT_CLAUDE_CONFIG,
  codex: DEFAULT_CODEX_CONFIG,
  opencode: DEFAULT_OPENCODE_CONFIG,
}

export function defaultConfigFor(agent: AgentConfig['agent']): AgentConfig {
  return DEFAULT_CONFIGS[agent]
}

