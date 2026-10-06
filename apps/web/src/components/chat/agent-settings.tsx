import { BookOpen, Box, Brain, Compass, FilePen, Globe, MessageSquareText, ShieldCheck, Sparkles, SquareTerminal, UserRoundSearch, UsersRound, Zap } from 'lucide-react'
import { cloneElement, useMemo, type ReactElement, type ReactNode } from 'react'
import {
  CLI_DEFAULT,
  claudeEffortSchema,
  codexModeSchema,
  DEFAULT_CLAUDE_CONFIG,
  type AgentConfig,
  type AgentModelDto,
  type ClaudeConfig,
  type CodexApprovalName,
  type CodexConfig,
  type CodexMode,
  type McpServerStatus,
  type OpencodePermission,
  type OpencodePermissions,
} from '@sillage/protocol'
import { effortsFor, supportsFastMode, useAgentModels } from '../../lib/agents'
import { useMcpServers } from '../../lib/mcp'
import { useSkillLibrary } from '../../lib/skill-library'
import { useTranslate, type MessageKey, type MessageParams } from '../../lib/i18n'
import {
  setting,
  type SettingChoice,
  type SettingGroup,
  type SettingOption,
  type SummarySegment,
} from './ComposerSettings'
import { McpControl, type McpControlProps } from './McpControl'

/**
 * Réglages d'une configuration d'agent, sous la forme de catégories d'options.
 *
 * Partagé par le composer, qui règle une conversation, et l'écran des défauts de
 * compte, qui règle avec quoi les suivantes s'ouvriront. Les deux posent exactement la
 * même question au même objet : dupliquer la liste des modes de permission ou la
 * gestion des sentinelles aurait garanti que les deux écrans divergent.
 *
 * Ce module produit des données, pas une disposition : le composer les empile dans un
 * panneau à plat, la page de réglages les déplie. Seul le contrôle MCP arrive
 * déjà rendu, n'étant pas un choix unique parmi une liste.
 */

/** Traduction, passée aux fabriques d'options qui vivent hors du composant. */
type Translate = (key: MessageKey, params?: MessageParams) => string

function permissionOptions(t: Translate): SettingChoice<ClaudeConfig['permissionMode']>[] {
  return [
    { value: 'manual', label: t('composer.permission.manual'), hint: t('composer.permission.manual.hint') },
    { value: 'auto', label: t('composer.permission.auto'), hint: t('composer.permission.auto.hint') },
    {
      value: 'acceptEdits',
      label: t('composer.permission.acceptEdits'),
      hint: t('composer.permission.acceptEdits.hint'),
    },
    { value: 'plan', label: t('composer.permission.plan'), hint: t('composer.permission.plan.hint') },
    {
      value: 'dontAsk',
      label: t('composer.permission.dontAsk'),
      hint: t('composer.permission.dontAsk.hint'),
    },
    {
      value: 'bypassPermissions',
      label: t('composer.permission.bypass'),
      hint: t('composer.permission.bypass.hint'),
      tone: 'caution',
    },
  ]
}

/**
 * Valeur d'affichage de la sentinelle `CLI_DEFAULT` dans le sélecteur d'approbation.
 * Laisser Codex appliquer sa propre politique est un état réel du protocole
 * (`approvalPolicy: null`), pas un trou : il mérite d'être nommé et sélectionnable.
 */
const CLI_DEFAULT_CHOICE = 'cli-default'

type ApprovalChoice = CodexApprovalName | typeof CLI_DEFAULT_CHOICE | 'granular'

/**
 * Vocabulaire natif de Codex, volontairement non aligné sur celui de Claude : les
 * deux CLI n'ont pas les mêmes concepts, et inventer une abstraction commune
 * mentirait sur ce qui se passe réellement.
 */
function codexApprovalOptions(t: Translate): SettingChoice<ApprovalChoice>[] {
  return [
    {
      value: CLI_DEFAULT_CHOICE,
      label: t('composer.approval.cliDefault'),
      hint: t('composer.approval.cliDefault.hint'),
    },
    {
      value: 'untrusted',
      label: t('composer.approval.untrusted'),
      hint: t('composer.approval.untrusted.hint'),
    },
    {
      value: 'on-request',
      label: t('composer.approval.onRequest'),
      hint: t('composer.approval.onRequest.hint'),
    },
    {
      value: 'never',
      label: t('composer.approval.never'),
      hint: t('composer.approval.never.hint'),
      tone: 'caution',
    },
  ]
}

/**
 * Le mode rapide de Claude Code, en deux valeurs plutôt qu'une case à cocher : le
 * panneau ne connaît que des listes, et « Standard » mérite d'être nommé autant que
 * « Rapide », puisque c'est le tarif qui les sépare.
 */
type SpeedChoice = 'standard' | 'fast'

function speedOptions(t: Translate): SettingChoice<SpeedChoice>[] {
  return [
    { value: 'standard', label: t('composer.speed.standard'), hint: t('composer.speed.standard.hint') },
    { value: 'fast', label: t('composer.speed.fast'), hint: t('composer.speed.fast.hint') },
  ]
}

/**
 * Ultracode, en deux valeurs pour la même raison que la vitesse. L'allumé porte le ton
 * de mise en garde : il lance des workflows multi-agents à chaque tâche de fond, et le
 * résumé doit le montrer tant qu'il dépense.
 */
type UltracodeChoice = 'off' | 'on'

function ultracodeOptions(t: Translate): SettingChoice<UltracodeChoice>[] {
  return [
    { value: 'off', label: t('composer.ultracode.off'), hint: t('composer.ultracode.off.hint') },
    { value: 'on', label: t('composer.ultracode.on'), hint: t('composer.ultracode.on.hint'), tone: 'caution' },
  ]
}

/**
 * La bibliothèque de skills de Sillage, livrée ou non à la session. Un choix à deux
 * valeurs plutôt qu'une case, pour se ranger avec les autres réglages du panneau.
 */
type LibraryChoice = 'on' | 'off'

function skillLibraryOptions(t: Translate): SettingChoice<LibraryChoice>[] {
  return [
    { value: 'on', label: t('composer.skillLibrary.on'), hint: t('composer.skillLibrary.on.hint') },
    { value: 'off', label: t('composer.skillLibrary.off'), hint: t('composer.skillLibrary.off.hint') },
  ]
}

const libraryChoice = (enabled: boolean): LibraryChoice => (enabled ? 'on' : 'off')

function codexSandboxOptions(t: Translate): SettingChoice<CodexConfig['sandbox']>[] {
  return [
    { value: 'read-only', label: t('composer.sandbox.readOnly'), hint: t('composer.sandbox.readOnly.hint') },
    {
      value: 'workspace-write',
      label: t('composer.sandbox.workspaceWrite'),
      hint: t('composer.sandbox.workspaceWrite.hint'),
    },
    {
      value: 'danger-full-access',
      label: t('composer.sandbox.fullAccess'),
      hint: t('composer.sandbox.fullAccess.hint'),
      tone: 'caution',
    },
  ]
}

/**
 * Règle d'opencode pour une famille d'outils, dans son vocabulaire : demander, laisser
 * faire, refuser. La sentinelle `CLI_DEFAULT` est un état réel, celui où Sillage ne pose
 * aucune règle et où l'`opencode.json` du poste décide : elle a son entrée, comme la
 * politique d'approbation de Codex.
 */
type OpencodePermissionChoice = Exclude<OpencodePermission, ''> | typeof CLI_DEFAULT_CHOICE

function opencodePermissionOptions(t: Translate): SettingChoice<OpencodePermissionChoice>[] {
  return [
    { value: 'ask', label: t('composer.opencodePermission.ask'), hint: t('composer.opencodePermission.ask.hint') },
    {
      value: 'allow',
      label: t('composer.opencodePermission.allow'),
      hint: t('composer.opencodePermission.allow.hint'),
      tone: 'caution',
    },
    { value: 'deny', label: t('composer.opencodePermission.deny'), hint: t('composer.opencodePermission.deny.hint') },
    {
      value: CLI_DEFAULT_CHOICE,
      label: t('composer.opencodePermission.cliDefault'),
      hint: t('composer.opencodePermission.cliDefault.hint'),
    },
  ]
}

const opencodePermissionChoice = (value: OpencodePermission): OpencodePermissionChoice =>
  value === CLI_DEFAULT ? CLI_DEFAULT_CHOICE : value

/** Les familles réglables, dans l'ordre du panneau, avec leur intitulé et leur icône. */
const OPENCODE_PERMISSIONS: { family: keyof OpencodePermissions; label: MessageKey; icon: ReactElement }[] = [
  { family: 'edit', label: 'composer.setting.opencodeEdit', icon: <FilePen size={15} /> },
  { family: 'bash', label: 'composer.setting.opencodeBash', icon: <SquareTerminal size={15} /> },
  { family: 'webfetch', label: 'composer.setting.opencodeWebfetch', icon: <Globe size={15} /> },
]

/**
 * Nomme le modèle derrière la ligne par défaut du catalogue.
 *
 * Claude Code appelle la sienne « Default (recommended) », ce qui est long et ne dit
 * pas qui répondra. Une autre ligne pointe le même `resolvedModel` et porte, elle, un
 * nom lisible : c'est celui-là qu'on affiche. Null quand aucune ne correspond, faute
 * de quoi il faudrait inventer un nom de modèle, ce qui serait pire que de rester
 * vague.
 */
function defaultModelLabel(
  models: AgentModelDto[],
  row: AgentModelDto,
  t: Translate,
): string | null {
  if (!row.hint) return null
  const alias = models.find((model) => !model.isDefault && model.hint === row.hint)
  return alias ? t('composer.model.defaultNamed', { model: alias.displayName }) : null
}

/**
 * Le libellé de la valeur que la session applique encore, quand ce n'est pas celle
 * qui est choisie. Null quand les deux coïncident, donc partout sauf entre un réglage
 * que le CLI refuse de changer en vol et le redémarrage qui le prend en compte.
 *
 * Un libellé et non un drapeau : « en attente » ne dit pas sous quel régime le tour se
 * déroule, ce qu'on cherche justement à savoir quand on vient de poser ou de lever un
 * garde-fou.
 */
function appliedLabel(
  applied: string | undefined,
  chosen: string,
  options: SettingOption[],
): string | null {
  if (applied === undefined || applied === chosen) return null
  return options.find((option) => option.value === applied)?.label ?? applied
}

/** La mention posée sur la ligne du réglage, absente quand rien n'attend. */
function notice(applied: string | null, t: Translate): string | undefined {
  return applied === null ? undefined : t('composer.setting.pending', { value: applied })
}

/** Voir `appliedLabel` : la même comparaison, pour la rangée de signaux. */
export function appliedPermissionLabel(
  config: AgentConfig,
  applied: AgentConfig | null,
  t: Translate,
): string | null {
  if (config.agent !== 'claude' || applied?.agent !== 'claude') return null
  return appliedLabel(applied.permissionMode, config.permissionMode, permissionOptions(t))
}

export interface AgentSettings {
  /** Les catégories, dans l'ordre où on les change. */
  groups: SettingGroup[]
  /** Valeurs annoncées par l'accès complet et états de permissions à garder visibles. */
  summary: SummarySegment[]
  /** Serveurs MCP et isolation stricte, déjà rendus. */
  mcp: ReactNode
  /** Les mêmes contrôles MCP, dépliés dans la vue complète du composer. */
  mcpPanel: ReactNode
  /** Le CLI n'a pas répondu : la liste des modèles se réduit à ce qui est enregistré. */
  catalogError: Error | null
}

interface AgentSettingsParams {
  config: AgentConfig
  onConfigChange: (config: AgentConfig) => void
  /**
   * Configuration sous laquelle le CLI tourne réellement, `null` à froid ou hors d'une
   * conversation lancée. Ce qui y diffère de `config` est un réglage choisi que la
   * session n'a pas pu adopter en vol et qui attend son redémarrage.
   */
  appliedConfig?: AgentConfig | null
  /**
   * Inventaire MCP rapporté par la session en cours. Absent hors d'une conversation
   * lancée : le contrôle retombe alors sur ce que la configuration décrit.
   */
  mcpInventory?: McpServerStatus[]
  disabled?: boolean
}

/** Référence stable : un tableau littéral par défaut relancerait le rendu du contrôle. */
const NO_INVENTORY: McpServerStatus[] = []

export function useAgentSettings({
  config,
  onConfigChange,
  appliedConfig = null,
  mcpInventory = NO_INVENTORY,
  disabled = false,
}: AgentSettingsParams): AgentSettings {
  const t = useTranslate()
  // Une seule sonde, celle de l'agent visé : chaque sonde démarre le CLI correspondant
  // côté serveur.
  const { data: catalog, error: catalogError } = useAgentModels(config.agent)

  // Copies constantes de la configuration : TypeScript ne conserve pas l'affinement
  // d'un paramètre à l'intérieur des fonctions de rendu construites plus bas.
  const claude = config.agent === 'claude' ? config : null
  const codex = config.agent === 'codex' ? config : null
  const opencode = config.agent === 'opencode' ? config : null

  /**
   * Modèle réellement en vigueur. `CLI_DEFAULT` ne désigne aucune entrée du catalogue :
   * l'afficher tel quel donnait un sélecteur vide et, faute de modèle trouvé, aucun
   * niveau d'effort. Le CLI annonce lequel de ses modèles il prendrait, c'est celui-là
   * que la barre montre. La configuration, elle, garde la sentinelle : c'est au serveur
   * de la résoudre au moment de créer la conversation.
   */
  const resolvedModel =
    config.model || catalog?.models.find((model) => model.isDefault)?.value || CLI_DEFAULT

  const modelOptions = useMemo((): SettingChoice<string>[] => {
    const models = catalog?.models ?? []
    const known = models.map((model) => {
      const named = model.isDefault ? defaultModelLabel(models, model, t) : null
      return {
        value: model.value,
        label: named ?? model.displayName,
        // `hint` porte la version réelle derrière un alias : sans elle, « Opus » ne
        // dit pas quelle génération va effectivement répondre. Le rappel « par
        // défaut » ne sert que si le libellé n'a pas déjà pu le dire.
        hint: [
          model.description,
          model.hint,
          !named && model.isDefault ? t('composer.model.default') : null,
        ]
          .filter(Boolean)
          .join(' · '),
      }
    })

    // Le modèle enregistré doit rester sélectionnable même si le catalogue n'a pas pu
    // être lu, sinon le select s'affiche vide et efface le réglage de la conversation.
    // Seulement s'il y a un réglage à préserver : la sentinelle n'en est pas un.
    if (config.model && !known.some((option) => option.value === config.model)) {
      known.unshift({ value: config.model, label: config.model, hint: t('composer.select.saved') })
    }
    return known
  }, [catalog, config.model, t])

  const effortOptions = useMemo((): SettingChoice<string>[] => {
    const known = effortsFor(catalog?.models, resolvedModel).map((effort) => ({
      value: effort.value,
      label: effort.label,
      hint: effort.hint ?? undefined,
    }))

    // Même règle que pour le modèle : le niveau enregistré reste sélectionnable et
    // lisible quand le catalogue ne le déclare pas (ou plus). Seulement si le modèle
    // gère l'effort : sinon le sélecteur n'a pas à exister.
    const current =
      config.agent === 'claude' ? config.effort : config.agent === 'codex' ? config.reasoningEffort : config.variant
    if (known.length > 0 && current && !known.some((option) => option.value === current)) {
      known.unshift({ value: current, label: current, hint: t('composer.select.saved') })
    }
    return known
  }, [catalog, config, resolvedModel, t])

  /**
   * Le mode rapide n'est proposé que s'il peut servir : un compte qui y a droit, et un
   * modèle qui le gère. Absent sinon, plutôt que grisé, comme l'effort ; et absent sur
   * un CLI qui ne connaît pas la notion, dont le catalogue laisse `fastMode` null.
   */
  const speedOffered =
    claude !== null &&
    catalog?.fastMode?.available === true &&
    supportsFastMode(catalog.models, resolvedModel)

  /**
   * Ultracode tient l'effort à `xhigh` : le CLI le refuse sur un modèle qui ne gère pas
   * ce niveau, donc le réglage n'existe que là, comme le mode rapide.
   */
  const supportsUltracode = (model: string): boolean =>
    effortsFor(catalog?.models, model).some((effort) => effort.value === 'xhigh')
  const ultracodeOffered = claude !== null && supportsUltracode(resolvedModel)

  /**
   * Styles de réponse annoncés par le CLI, derrière une entrée « par défaut » : la
   * configuration vide veut dire « laisser le style habituel », et Radix refuse une
   * option de valeur vide, d'où la même sentinelle d'affichage que l'approbation.
   */
  const outputStyleOptions = useMemo((): SettingChoice<string>[] => {
    const styles = catalog?.outputStyles ?? []
    if (!claude || styles.length === 0) return []
    const known: SettingChoice<string>[] = [
      {
        value: CLI_DEFAULT_CHOICE,
        label: t('composer.outputStyle.default'),
        hint: t('composer.outputStyle.default.hint'),
      },
      ...styles.map((style) => ({ value: style, label: style })),
    ]
    if (claude.outputStyle && !styles.includes(claude.outputStyle)) {
      known.push({ value: claude.outputStyle, label: claude.outputStyle, hint: t('composer.select.saved') })
    }
    return known
  }, [catalog, claude, t])

  /**
   * Modèles pouvant servir de conseiller : ceux du catalogue, moins la ligne « par
   * défaut » qui ne nomme personne, derrière une entrée « aucun ».
   */
  const advisorOptions = useMemo((): SettingChoice<string>[] => {
    const models = catalog?.models ?? []
    if (!claude || models.length === 0) return []
    const known: SettingChoice<string>[] = [
      { value: CLI_DEFAULT_CHOICE, label: t('composer.advisor.none'), hint: t('composer.advisor.none.hint') },
      ...models
        .filter((model) => !model.isDefault)
        .map((model) => ({
          value: model.value,
          label: model.displayName,
          hint: [model.hint, t('composer.advisor.model.hint')].filter(Boolean).join(' · '),
        })),
    ]
    if (claude.advisorModel && !known.some((option) => option.value === claude.advisorModel)) {
      known.push({ value: claude.advisorModel, label: claude.advisorModel, hint: t('composer.select.saved') })
    }
    return known
  }, [catalog, claude, t])

  /**
   * Même sentinelle côté effort, que seul Codex laisse vide : le niveau montré est
   * celui que le modèle retenu annonce par défaut.
   */
  const resolvedEffort = codex
    ? codex.reasoningEffort ||
      catalog?.models.find((model) => model.value === resolvedModel)?.defaultEffort ||
      CLI_DEFAULT
    : CLI_DEFAULT

  /**
   * Modes de collaboration annoncés par Codex. Le mode décide des outils accessibles
   * au modèle : en mode Plan, il peut poser des questions à choix, ce que le routeur
   * du CLI refuse autrement. La liste vient du CLI, donc elle disparaît si la version
   * installée ne la connaît pas, et reste vide pour les CLI sans cette notion.
   */
  const codexModeOptions = useMemo((): SettingChoice<CodexMode>[] => {
    // La liste est une chaîne libre côté protocole, opencode y rangeant ses agents :
    // seuls les modes que Codex connaît peuvent partir dans sa configuration.
    return (catalog?.modes ?? []).flatMap((entry) => {
      const mode = codexModeSchema.safeParse(entry.mode)
      return mode.success ? [{ value: mode.data, label: entry.label }] : []
    })
  }, [catalog])

  /**
   * Agents primaires d'opencode (`build`, `plan`, ceux de l'utilisateur) : le pendant
   * des modes de collaboration, à ceci près que la liste est ouverte. L'agent
   * enregistré reste sélectionnable même si le catalogue ne l'annonce pas.
   */
  const primaryAgentOptions = useMemo((): SettingChoice<string>[] => {
    if (!opencode) return []
    const known: SettingChoice<string>[] = (catalog?.modes ?? []).map((entry) => ({
      value: entry.mode,
      label: entry.label,
      hint: entry.hint ?? undefined,
    }))
    if (!known.some((option) => option.value === opencode.primaryAgent)) {
      known.unshift({ value: opencode.primaryAgent, label: opencode.primaryAgent, hint: t('composer.select.saved') })
    }
    return known
  }, [catalog, opencode, t])

  /**
   * Variantes du modèle, derrière une entrée « par défaut » : sans variante, opencode
   * laisse au modèle ses réglages propres, et aucune des variantes ne désigne cet état.
   */
  const variantOptions = useMemo((): SettingChoice<string>[] => {
    if (!opencode || effortOptions.length === 0) return []
    return [
      { value: CLI_DEFAULT_CHOICE, label: t('composer.variant.default'), hint: t('composer.variant.default.hint') },
      ...effortOptions,
    ]
  }, [effortOptions, opencode, t])

  // L'approbation peut être un objet granulaire, que Sillage n'édite pas : il est
  // alors affiché comme une option non modifiable plutôt que comme un select vide.
  const approval = config.agent === 'codex' ? config.askForApproval : CLI_DEFAULT
  const granular = typeof approval !== 'string'

  // Radix refuse une option de valeur vide : la sentinelle « le CLI décide » a donc
  // besoin d'une valeur d'affichage propre, traduite dans les deux sens ci-dessous.
  const approvalValue: ApprovalChoice = granular
    ? 'granular'
    : approval === CLI_DEFAULT
      ? CLI_DEFAULT_CHOICE
      : approval

  const approvalOptions: SettingChoice<ApprovalChoice>[] = granular
    ? [
        {
          value: 'granular',
          label: t('composer.approval.granular'),
          hint: t('composer.approval.granular.hint'),
          disabled: true,
        },
        ...codexApprovalOptions(t),
      ]
    : codexApprovalOptions(t)

  /**
   * Chaque modèle expose ses propres niveaux. Garder l'effort courant quand le
   * nouveau modèle ne le connaît pas ferait échouer le tour côté CLI : on retombe
   * alors sur le repli annoncé par le catalogue.
   */
  const clampEffort = (model: string, current: string): string => {
    if (effortsFor(catalog?.models, model).some((effort) => effort.value === current)) {
      return current
    }
    return catalog?.models.find((entry) => entry.value === model)?.defaultEffort ?? ''
  }

  /** Même repli, ramené dans l'enum du protocole que `ClaudeConfig.effort` exige. */
  const clampClaudeEffort = (model: string, current: string): ClaudeConfig['effort'] => {
    const parsed = claudeEffortSchema.safeParse(clampEffort(model, current))
    return parsed.success ? parsed.data : DEFAULT_CLAUDE_CONFIG.effort
  }

  /**
   * Intitulé de la valeur en cours. Le repli sur la valeur brute couvre la sentinelle
   * `CLI_DEFAULT`, qui n'a pas d'option nommée dans les listes de modèles.
   */
  const labelOf = <T extends string>(options: SettingChoice<T>[], value: T): string =>
    options.find((option) => option.value === value)?.label || value || t('composer.select.default')

  /**
   * Un créneau du résumé.
   *
   * Le ton vient de l'option choisie, et non d'une seconde liste de valeurs
   * dangereuses tenue en parallèle. Un garde-fou levé reste visible à toute largeur.
   */
  const segment = <T extends string>(
    key: string,
    options: SettingChoice<T>[],
    value: T,
  ): SummarySegment => {
    const tone = options.find((option) => option.value === value)?.tone
    return { key, label: labelOf(options, value), tone }
  }

  // Le registre est partagé par toute l'instance : la requête est mise en cache par
  // React Query et ne repart pas à chaque conversation ouverte.
  const mcpRegistry = useMcpServers().data
  // Absent quand l'instance a coupé la bibliothèque : un réglage sans effet n'a pas à
  // occuper le panneau, comme le serveur MCP de Sillage.
  const libraryAvailable = useSkillLibrary(null).data?.enabled === true
  const libraryOptionList = skillLibraryOptions(t)
  const mcpServers = mcpRegistry?.servers ?? []
  // Faux tant que la requête n'a pas répondu, comme pour une instance qui ne monte pas
  // le serveur : la ligne apparaît alors au chargement du registre, plutôt que de
  // s'afficher d'abord puis de disparaître sous le curseur.
  const sillageAvailable = mcpRegistry?.sillageServer === true

  const permissionOptionList = permissionOptions(t)
  const sandboxOptionList = codexSandboxOptions(t)
  const speedOptionList = speedOptions(t)
  const ultracodeOptionList = ultracodeOptions(t)
  const opencodePermissionList = opencodePermissionOptions(t)

  let groups: SettingGroup[] = []
  let summary: SummarySegment[] = []
  let mcp: ReactElement<McpControlProps> | null = null

  if (claude) {
    groups = [
      setting({
        key: 'model',
        label: t('composer.setting.model'),
        icon: <Sparkles size={15} />,
        options: modelOptions,
        value: resolvedModel,
        onChange: (model) =>
          onConfigChange({
            ...claude,
            model,
            effort: clampClaudeEffort(model, claude.effort),
            // Garder le mode rapide sur un modèle qui ne le gère pas ferait basculer
            // le CLI sur Opus sans prévenir : il retombe avec le modèle.
            fastMode: claude.fastMode && supportsFastMode(catalog?.models, model),
            ultracode: claude.ultracode && supportsUltracode(model),
          }),
      }),
      // Absente plutôt que grisée quand le modèle n'a pas de niveaux d'effort : un
      // réglage sans effet n'a pas à occuper le panneau.
      ...(effortOptions.length > 0
        ? [
            setting({
              key: 'effort',
              label: t('composer.setting.effort'),
              icon: <Brain size={15} />,
              options: effortOptions,
              value: claude.effort,
              onChange: (effort) => {
                // Les options sont génériques sur des chaînes ; l'enum du protocole
                // fait foi, une valeur inconnue ne part pas.
                const parsed = claudeEffortSchema.safeParse(effort)
                if (parsed.success) onConfigChange({ ...claude, effort: parsed.data })
              },
            }),
          ]
        : []),
      ...(speedOffered
        ? [
            setting({
              key: 'speed',
              label: t('composer.setting.speed'),
              icon: <Zap size={15} />,
              options: speedOptionList,
              value: claude.fastMode ? 'fast' : 'standard',
              onChange: (speed) => onConfigChange({ ...claude, fastMode: speed === 'fast' }),
            }),
          ]
        : []),
      ...(ultracodeOffered
        ? [
            setting({
              key: 'ultracode',
              label: t('composer.setting.ultracode'),
              icon: <UsersRound size={15} />,
              options: ultracodeOptionList,
              value: claude.ultracode ? 'on' : 'off',
              // L'allumer aligne l'effort sur le `xhigh` qu'impose le CLI, pour que le
              // panneau dise vrai ; l'éteindre laisse l'effort où il est, comme le CLI.
              onChange: (choice) =>
                onConfigChange(
                  choice === 'on' ? { ...claude, ultracode: true, effort: 'xhigh' } : { ...claude, ultracode: false },
                ),
            }),
          ]
        : []),
      setting({
        key: 'permission',
        label: t('composer.setting.permission'),
        icon: <ShieldCheck size={15} />,
        options: permissionOptionList,
        value: claude.permissionMode,
        onChange: (permissionMode) => onConfigChange({ ...claude, permissionMode }),
        // Le seul réglage du panneau que Claude Code refuse de changer en vol : entrer
        // dans « Tout autoriser » comme en sortir demande de relancer la session. Le
        // CLI est comparé aussi : un `appliedConfig` reçu à l'instant où l'on bascule
        // de CLI décrirait encore la session de l'autre.
        notice: notice(
          appliedLabel(
            appliedConfig?.agent === 'claude' ? appliedConfig.permissionMode : undefined,
            claude.permissionMode,
            permissionOptionList,
          ),
          t,
        ),
      }),
      // Absents quand le catalogue n'en annonce pas, comme l'effort : un CLI sans
      // styles ou sans modèles n'a pas à montrer un sélecteur vide.
      ...(outputStyleOptions.length > 0
        ? [
            setting({
              key: 'outputStyle',
              label: t('composer.setting.outputStyle'),
              icon: <MessageSquareText size={15} />,
              options: outputStyleOptions,
              value: claude.outputStyle || CLI_DEFAULT_CHOICE,
              onChange: (style) =>
                onConfigChange({ ...claude, outputStyle: style === CLI_DEFAULT_CHOICE ? CLI_DEFAULT : style }),
            }),
          ]
        : []),
      ...(advisorOptions.length > 0
        ? [
            setting({
              key: 'advisor',
              label: t('composer.setting.advisor'),
              icon: <UserRoundSearch size={15} />,
              options: advisorOptions,
              value: claude.advisorModel || CLI_DEFAULT_CHOICE,
              onChange: (model) =>
                onConfigChange({ ...claude, advisorModel: model === CLI_DEFAULT_CHOICE ? CLI_DEFAULT : model }),
            }),
          ]
        : []),
      ...(libraryAvailable
        ? [
            setting({
              key: 'skillLibrary',
              label: t('composer.setting.skillLibrary'),
              icon: <BookOpen size={15} />,
              options: libraryOptionList,
              value: libraryChoice(claude.skillLibrary),
              onChange: (choice) => onConfigChange({ ...claude, skillLibrary: choice === 'on' }),
              // Comme le mode de permission : Claude ne reçoit ses plugins qu'au
              // lancement, le changement attend la relance de la session.
              notice: notice(
                appliedLabel(
                  appliedConfig?.agent === 'claude' ? libraryChoice(appliedConfig.skillLibrary) : undefined,
                  libraryChoice(claude.skillLibrary),
                  libraryOptionList,
                ),
                t,
              ),
            }),
          ]
        : []),
    ]

    summary = [
      segment('model', modelOptions, resolvedModel),
      ...(effortOptions.length > 0 ? [segment('effort', effortOptions, claude.effort)] : []),
      // Le mode rapide coûte à chaque tour : tant qu'il est allumé, il se lit dans le
      // résumé, comme un garde-fou levé se lit dans le sien.
      ...(speedOffered && claude.fastMode ? [segment('speed', speedOptionList, 'fast')] : []),
      ...(ultracodeOffered && claude.ultracode ? [segment('ultracode', ultracodeOptionList, 'on')] : []),
      segment('permission', permissionOptionList, claude.permissionMode),
    ]

    mcp = (
      <McpControl
        servers={mcpServers}
        inventory={mcpInventory}
        selected={claude.mcpServers}
        onSelectedChange={(ids) => onConfigChange({ ...claude, mcpServers: ids })}
        sillage={sillageAvailable ? claude.sillageMcp : null}
        onSillageChange={(sillageMcp) => onConfigChange({ ...claude, sillageMcp })}
        strict={claude.strictMcp}
        onStrictChange={(strictMcp) => onConfigChange({ ...claude, strictMcp })}
        disabled={disabled}
      />
    )
  } else if (codex) {
    groups = [
      setting({
        key: 'model',
        label: t('composer.setting.model'),
        icon: <Sparkles size={15} />,
        options: modelOptions,
        value: resolvedModel,
        onChange: (model) =>
          onConfigChange({
            ...codex,
            model,
            reasoningEffort: clampEffort(model, codex.reasoningEffort),
          }),
      }),
      ...(codexModeOptions.length > 0
        ? [
            setting({
              key: 'mode',
              label: t('composer.setting.mode'),
              icon: <Compass size={15} />,
              options: codexModeOptions,
              value: codex.collaborationMode,
              onChange: (collaborationMode) => onConfigChange({ ...codex, collaborationMode }),
            }),
          ]
        : []),
      ...(effortOptions.length > 0
        ? [
            setting({
              key: 'effort',
              label: t('composer.setting.effort'),
              icon: <Brain size={15} />,
              options: effortOptions,
              value: resolvedEffort,
              onChange: (reasoningEffort) => onConfigChange({ ...codex, reasoningEffort }),
            }),
          ]
        : []),
      setting({
        key: 'approval',
        label: t('composer.setting.approval'),
        icon: <ShieldCheck size={15} />,
        options: approvalOptions,
        value: approvalValue,
        onChange: (choice) => {
          // 'granular' n'est qu'un repère d'affichage, il n'est pas sélectionnable et
          // ne doit jamais repartir vers le serveur.
          if (choice === 'granular') return
          onConfigChange({
            ...codex,
            askForApproval: choice === CLI_DEFAULT_CHOICE ? CLI_DEFAULT : choice,
          })
        },
      }),
      setting({
        key: 'sandbox',
        label: t('composer.setting.sandbox'),
        icon: <Box size={15} />,
        options: sandboxOptionList,
        value: codex.sandbox,
        onChange: (sandbox) => onConfigChange({ ...codex, sandbox }),
      }),
      // Appliqué à chaud par Codex, d'où l'absence de mention d'attente.
      ...(libraryAvailable
        ? [
            setting({
              key: 'skillLibrary',
              label: t('composer.setting.skillLibrary'),
              icon: <BookOpen size={15} />,
              options: libraryOptionList,
              value: libraryChoice(codex.skillLibrary),
              onChange: (choice) => onConfigChange({ ...codex, skillLibrary: choice === 'on' }),
            }),
          ]
        : []),
    ]

    // Les levées d'approbation et de bac à sable restent visibles simultanément.
    const approvalOff = approvalValue === 'never'
    summary = [
      segment('model', modelOptions, resolvedModel),
      ...(effortOptions.length > 0 ? [segment('effort', effortOptions, resolvedEffort)] : []),
      ...(approvalOff ? [segment('approval', approvalOptions, approvalValue)] : []),
      ...(approvalOff && codex.sandbox !== 'danger-full-access'
        ? []
        : [segment('sandbox', sandboxOptionList, codex.sandbox)]),
    ]

    mcp = (
      <McpControl
        servers={mcpServers}
        inventory={mcpInventory}
        selected={codex.mcpServers}
        onSelectedChange={(ids) => onConfigChange({ ...codex, mcpServers: ids })}
        sillage={sillageAvailable ? codex.sillageMcp : null}
        onSillageChange={(sillageMcp) => onConfigChange({ ...codex, sillageMcp })}
        strict={null}
        onStrictChange={() => {}}
        disabled={disabled}
      />
    )
  } else if (opencode) {
    const applied = appliedConfig?.agent === 'opencode' ? appliedConfig : null
    const variant = opencode.variant || CLI_DEFAULT_CHOICE

    groups = [
      setting({
        key: 'model',
        label: t('composer.setting.model'),
        icon: <Sparkles size={15} />,
        options: modelOptions,
        value: resolvedModel,
        // Une variante que le nouveau modèle ne connaît pas retombe sur ses réglages
        // propres, qui existent toujours.
        onChange: (model) =>
          onConfigChange({ ...opencode, model, variant: clampEffort(model, opencode.variant) }),
      }),
      setting({
        key: 'mode',
        label: t('composer.setting.primaryAgent'),
        icon: <Compass size={15} />,
        options: primaryAgentOptions,
        value: opencode.primaryAgent,
        onChange: (primaryAgent) => onConfigChange({ ...opencode, primaryAgent }),
      }),
      ...(variantOptions.length > 0
        ? [
            setting({
              key: 'effort',
              label: t('composer.setting.variant'),
              icon: <Brain size={15} />,
              options: variantOptions,
              value: variant,
              onChange: (choice) =>
                onConfigChange({ ...opencode, variant: choice === CLI_DEFAULT_CHOICE ? CLI_DEFAULT : choice }),
            }),
          ]
        : []),
      // opencode lit ses règles au lancement : comme le mode de permission de Claude,
      // un changement attend la relance de la session, et la ligne dit ce qui vaut
      // encore d'ici là.
      ...OPENCODE_PERMISSIONS.map(({ family, label, icon }) =>
        setting({
          key: `permission-${family}`,
          label: t(label),
          icon,
          options: opencodePermissionList,
          value: opencodePermissionChoice(opencode.permissions[family]),
          onChange: (choice) =>
            onConfigChange({
              ...opencode,
              permissions: {
                ...opencode.permissions,
                [family]: choice === CLI_DEFAULT_CHOICE ? CLI_DEFAULT : choice,
              },
            }),
          notice: notice(
            appliedLabel(
              applied ? opencodePermissionChoice(applied.permissions[family]) : undefined,
              opencodePermissionChoice(opencode.permissions[family]),
              opencodePermissionList,
            ),
            t,
          ),
        }),
      ),
      ...(libraryAvailable
        ? [
            setting({
              key: 'skillLibrary',
              label: t('composer.setting.skillLibrary'),
              icon: <BookOpen size={15} />,
              options: libraryOptionList,
              value: libraryChoice(opencode.skillLibrary),
              onChange: (choice) => onConfigChange({ ...opencode, skillLibrary: choice === 'on' }),
              notice: notice(
                appliedLabel(
                  applied ? libraryChoice(applied.skillLibrary) : undefined,
                  libraryChoice(opencode.skillLibrary),
                  libraryOptionList,
                ),
                t,
              ),
            }),
          ]
        : []),
    ]

    // Le résumé nomme la famille : « Autoriser » seul ne dirait pas quoi. Une famille
    // laissée libre reste visible, comme tout garde-fou levé ; les deux en « demander »
    // se résument en un mot.
    const { edit, bash } = opencode.permissions
    summary = [
      segment('model', modelOptions, resolvedModel),
      ...(opencode.variant ? [segment('effort', variantOptions, variant)] : []),
      ...(opencode.primaryAgent === 'build' ? [] : [segment('mode', primaryAgentOptions, opencode.primaryAgent)]),
      ...(edit === 'ask' && bash === 'ask'
        ? [{ key: 'permission', label: t('composer.opencodePermission.summary.ask') }]
        : []),
      ...(edit === 'allow'
        ? [{ key: 'permission-edit', label: t('composer.opencodePermission.summary.editAllow'), tone: 'caution' as const }]
        : []),
      ...(bash === 'allow'
        ? [{ key: 'permission-bash', label: t('composer.opencodePermission.summary.bashAllow'), tone: 'caution' as const }]
        : []),
    ]

    mcp = (
      <McpControl
        servers={mcpServers}
        inventory={mcpInventory}
        selected={opencode.mcpServers}
        onSelectedChange={(ids) => onConfigChange({ ...opencode, mcpServers: ids })}
        sillage={sillageAvailable ? opencode.sillageMcp : null}
        onSillageChange={(sillageMcp) => onConfigChange({ ...opencode, sillageMcp })}
        strict={null}
        onStrictChange={() => {}}
        disabled={disabled}
      />
    )
  }

  return { groups, summary, mcp, mcpPanel: mcp ? cloneElement(mcp, { presentation: 'panel' }) : null, catalogError }
}
