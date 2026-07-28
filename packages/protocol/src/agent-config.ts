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

export const claudeConfigSchema = z.object({
  agent: z.literal('claude'),
  model: z.string(),
  effort: claudeEffortSchema,
  permissionMode: claudePermissionModeSchema,
  additionalDirectories: z.array(z.string()).default([]),
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

/** `on-failure` est marqué déprécié par le CLI mais reste accepté par le protocole. */
export const codexApprovalNameSchema = z.enum([
  'untrusted',
  'on-failure',
  'on-request',
  'never',
])

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
 */
export const codexApprovalConfigSchema = z.union([
  z.literal(''),
  codexApprovalNameSchema,
  codexGranularApprovalSchema,
])

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
})
export type CodexConfig = z.infer<typeof codexConfigSchema>

export const agentConfigSchema = z.discriminatedUnion('agent', [
  claudeConfigSchema,
  codexConfigSchema,
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
}

export function defaultConfigFor(agent: AgentConfig['agent']): AgentConfig {
  return DEFAULT_CONFIGS[agent]
}

