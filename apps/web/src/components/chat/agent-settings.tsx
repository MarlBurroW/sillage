import { Box, Brain, Compass, ShieldCheck, Sparkles } from 'lucide-react'
import { useMemo, type ReactNode } from 'react'
import {
  CLI_DEFAULT,
  claudeEffortSchema,
  DEFAULT_CLAUDE_CONFIG,
  type AgentConfig,
  type AgentModelDto,
  type ClaudeConfig,
  type CodexApprovalName,
  type CodexConfig,
  type CodexMode,
  type McpServerStatus,
} from '@sillage/protocol'
import { effortsFor, useAgentModels } from '../../lib/agents'
import { useMcpServers } from '../../lib/mcp'
import { useTranslate, type MessageKey, type MessageParams } from '../../lib/i18n'
import {
  setting,
  type SettingChoice,
  type SettingGroup,
  type SummarySegment,
} from './ComposerSettings'
import { McpControl } from './McpControl'

/**
 * Réglages d'une configuration d'agent, sous la forme de catégories d'options.
 *
 * Partagé par le composer, qui règle une conversation, et l'écran des défauts de
 * compte, qui règle avec quoi les suivantes s'ouvriront. Les deux posent exactement la
 * même question au même objet : dupliquer la liste des modes de permission ou la
 * gestion des sentinelles aurait garanti que les deux écrans divergent.
 *
 * Ce module produit des données, pas une disposition : le composer les empile dans un
 * panneau à deux étages, la page de réglages les déplie. Seul le contrôle MCP arrive
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

export interface AgentSettings {
  /** Les catégories, dans l'ordre où on les change. */
  groups: SettingGroup[]
  /** Résumé compact des valeurs en cours, pour un déclencheur qui doit tenir sur une ligne. */
  summary: SummarySegment[]
  /** Serveurs MCP et isolation stricte, déjà rendus. */
  mcp: ReactNode
  /** Le CLI n'a pas répondu : la liste des modèles se réduit à ce qui est enregistré. */
  catalogError: Error | null
}

interface AgentSettingsParams {
  config: AgentConfig
  onConfigChange: (config: AgentConfig) => void
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
      config.agent === 'claude' ? config.effort : config.agent === 'codex' ? config.reasoningEffort : ''
    if (known.length > 0 && current && !known.some((option) => option.value === current)) {
      known.unshift({ value: current, label: current, hint: t('composer.select.saved') })
    }
    return known
  }, [catalog, config, resolvedModel, t])

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
    return (catalog?.modes ?? []).map((entry) => ({ value: entry.mode, label: entry.label }))
  }, [catalog])

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
   * dangereuses tenue en parallèle. Un garde-fou levé passe en tête d'ordre : aucune
   * largeur ne doit pouvoir l'effacer.
   */
  const segment = <T extends string>(
    key: string,
    options: SettingChoice<T>[],
    value: T,
    drop: 0 | 1 | 2,
  ): SummarySegment => {
    const tone = options.find((option) => option.value === value)?.tone
    return { key, label: labelOf(options, value), tone, drop: tone === 'caution' ? 0 : drop }
  }

  // Le registre est partagé par toute l'instance : la requête est mise en cache par
  // React Query et ne repart pas à chaque conversation ouverte.
  const mcpRegistry = useMcpServers().data
  const mcpServers = mcpRegistry?.servers ?? []
  // Faux tant que la requête n'a pas répondu, comme pour une instance qui ne monte pas
  // le serveur : la ligne apparaît alors au chargement du registre, plutôt que de
  // s'afficher d'abord puis de disparaître sous le curseur.
  const sillageAvailable = mcpRegistry?.sillageServer === true

  const permissionOptionList = permissionOptions(t)
  const sandboxOptionList = codexSandboxOptions(t)

  let groups: SettingGroup[] = []
  let summary: SummarySegment[] = []
  let mcp: ReactNode = null

  if (claude) {
    groups = [
      setting({
        key: 'model',
        label: t('composer.setting.model'),
        icon: <Sparkles size={15} />,
        options: modelOptions,
        value: resolvedModel,
        onChange: (model) =>
          onConfigChange({ ...claude, model, effort: clampClaudeEffort(model, claude.effort) }),
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
      setting({
        key: 'permission',
        label: t('composer.setting.permission'),
        icon: <ShieldCheck size={15} />,
        options: permissionOptionList,
        value: claude.permissionMode,
        onChange: (permissionMode) => onConfigChange({ ...claude, permissionMode }),
      }),
    ]

    summary = [
      segment('model', modelOptions, resolvedModel, 0),
      ...(effortOptions.length > 0 ? [segment('effort', effortOptions, claude.effort, 2)] : []),
      segment('permission', permissionOptionList, claude.permissionMode, 1),
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
    ]

    // Le mode de collaboration reste dans le panneau : il décide des outils
    // accessibles, pas de ce qui peut être détruit, et trois créneaux sont le maximum
    // lisible. Le bac à sable tient celui de la sûreté, sauf quand c'est l'approbation
    // qui est levée ; les deux levées, les deux s'affichent.
    const approvalOff = approvalValue === 'never'
    summary = [
      segment('model', modelOptions, resolvedModel, 0),
      ...(effortOptions.length > 0 ? [segment('effort', effortOptions, resolvedEffort, 2)] : []),
      ...(approvalOff ? [segment('approval', approvalOptions, approvalValue, 1)] : []),
      ...(approvalOff && codex.sandbox !== 'danger-full-access'
        ? []
        : [segment('sandbox', sandboxOptionList, codex.sandbox, 1)]),
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
  }

  return { groups, summary, mcp, catalogError }
}
