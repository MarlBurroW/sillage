import { useAntigravityAccounts } from '../../lib/antigravity-accounts'
import { BookOpen, Box, Brain, Compass, FilePen, Globe, IdCard, MessageSquareText, ShieldCheck, Sparkles, SquareTerminal, UserRoundSearch, UsersRound, Wallet, Zap } from 'lucide-react'
import { cloneElement, useCallback, useMemo, useState, type ReactElement, type ReactNode } from 'react'
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
  type GrokConfig,
  type AntigravityConfig,
  type McpServerStatus,
  type OpencodePermission,
  type OpencodePermissions,
} from '@sillage/protocol'
import { catalogModel, effortLabel, effortsFor, modelsAccount, supportsFastMode, useAgentModels, useRefreshAgentModels } from '../../lib/agents'
import { useClaudeAccounts } from '../../lib/claude-accounts'
import { useCodexAccounts } from '../../lib/codex-accounts'
import { useGrokAccounts } from '../../lib/grok-accounts'
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
 * Agent configuration settings as option categories. Shared by conversation composers and account
 * defaults for future conversations: both ask the same questions of the same object, so duplicating
 * permission modes or sentinel handling would guarantee divergence. Produces data rather than
 * layout: composers stack a flat panel while settings expand categories. Only MCP controls arrive
 * rendered because they are not single-choice lists.
 */

/** Translation passed to option factories outside the component. */
type Translate = (key: MessageKey, params?: MessageParams) => string

/**
 * Claude conversation spending cap in steps rather than free input: categories are choice lists and
 * steps fit composer chips. `none` removes the cap; exceeding it ends the turn with
 * `error_max_budget_usd`.
 */
const BUDGET_STEPS_USD = [2, 5, 10, 25, 50] as const

function budgetOptions(t: Translate, current: number | null): SettingChoice<string>[] {
  const options: SettingChoice<string>[] = [
    { value: 'none', label: t('composer.budget.none'), hint: t('composer.budget.none.hint') },
    ...BUDGET_STEPS_USD.map((amount) => ({ value: String(amount), label: t('composer.budget.amount', { amount }) })),
  ]
  // Amounts saved through the API or earlier versions remain readable and selectable.
  if (current !== null && !options.some((option) => option.value === String(current))) {
    options.push({ value: String(current), label: t('composer.budget.amount', { amount: current }), hint: t('composer.select.saved') })
  }
  return options
}

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
 * Grok Build modes mirror Claude Code except manual, called default. Reuse Claude labels except
 * automatic, whose hint names the deciding agent. All change live.
 */
function grokPermissionOptions(t: Translate): SettingChoice<GrokConfig['permissionMode']>[] {
  return [
    { value: 'default', label: t('composer.permission.manual'), hint: t('composer.permission.manual.hint') },
    { value: 'auto', label: t('composer.permission.auto'), hint: t('composer.grokPermission.auto.hint') },
    { value: 'plan', label: t('composer.permission.plan'), hint: t('composer.permission.plan.hint') },
    {
      value: 'bypassPermissions',
      label: t('composer.permission.bypass'),
      hint: t('composer.permission.bypass.hint'),
      tone: 'caution',
    },
  ]
}

type WebSearchChoice = 'on' | 'off'

function webSearchOptions(t: Translate): SettingChoice<WebSearchChoice>[] {
  return [
    { value: 'on', label: t('composer.webSearch.on'), hint: t('composer.webSearch.on.hint') },
    { value: 'off', label: t('composer.webSearch.off'), hint: t('composer.webSearch.off.hint') },
  ]
}

/**
 * Display value for `CLI_DEFAULT` in approval selection. Letting Codex apply its own policy is real
 * protocol state (`approvalPolicy: null`), deserving a named selectable entry.
 */
const CLI_DEFAULT_CHOICE = 'cli-default'

type ApprovalChoice = CodexApprovalName | typeof CLI_DEFAULT_CHOICE | 'granular'

/**
 * Native Codex vocabulary deliberately differs from Claude: their concepts differ and a shared
 * abstraction would misrepresent actual behavior.
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
 * Claude Code fast mode as two choices rather than a checkbox because panels use lists and Standard
 * deserves naming alongside Fast, whose price differs.
 */
type SpeedChoice = 'standard' | 'fast'

function speedOptions(t: Translate): SettingChoice<SpeedChoice>[] {
  return [
    { value: 'standard', label: t('composer.speed.standard'), hint: t('composer.speed.standard.hint') },
    { value: 'fast', label: t('composer.speed.fast'), hint: t('composer.speed.fast.hint') },
  ]
}

/**
 * Ultracode uses two choices for the same reason as speed. Enabled carries caution tone: it starts
 * multi-agent workflows for each background task and remains visible while spending.
 */
type UltracodeChoice = 'off' | 'on'

function ultracodeOptions(t: Translate): SettingChoice<UltracodeChoice>[] {
  return [
    { value: 'off', label: t('composer.ultracode.off'), hint: t('composer.ultracode.off.hint') },
    { value: 'on', label: t('composer.ultracode.on'), hint: t('composer.ultracode.on.hint'), tone: 'caution' },
  ]
}

/**
 * Whether to deliver Sillage's skill library to the session. Two choices rather than a checkbox to
 * fit other panel settings.
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
 * opencode tool-family rules in native vocabulary: ask, allow, deny. `CLI_DEFAULT` is real state
 * where Sillage supplies no rule and local opencode.json decides; give it an entry like Codex
 * approval policy.
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

/** Configurable families in panel order with titles and icons. */
const OPENCODE_PERMISSIONS: { family: keyof OpencodePermissions; label: MessageKey; icon: ReactElement }[] = [
  { family: 'edit', label: 'composer.setting.opencodeEdit', icon: <FilePen size={15} /> },
  { family: 'bash', label: 'composer.setting.opencodeBash', icon: <SquareTerminal size={15} /> },
  { family: 'webfetch', label: 'composer.setting.opencodeWebfetch', icon: <Globe size={15} /> },
]

/**
 * Name the model behind the default catalog entry. Claude Code's Default (recommended) is long and
 * does not identify the responding model. Another entry sharing resolvedModel has a readable name;
 * use it. Return null without a match rather than inventing a name.
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
 * Label for the value still applied by the session when different from the selection. Null when
 * equal, except between selecting a setting that cannot change live and restarting. A label rather
 * than a flag: pending does not explain which safeguards currently govern the turn.
 */
function appliedLabel(
  applied: string | undefined,
  chosen: string,
  options: SettingOption[],
): string | null {
  if (applied === undefined || applied === chosen) return null
  return options.find((option) => option.value === applied)?.label ?? applied
}

/** Setting-row annotation, absent when nothing is pending. */
function notice(applied: string | null, t: Translate): string | undefined {
  return applied === null ? undefined : t('composer.setting.pending', { value: applied })
}

/** See `appliedLabel`: same comparison for the signals row. */
export function appliedPermissionLabel(
  config: AgentConfig,
  applied: AgentConfig | null,
  t: Translate,
): string | null {
  if (config.agent !== 'claude' || applied?.agent !== 'claude') return null
  return appliedLabel(applied.permissionMode, config.permissionMode, permissionOptions(t))
}

export interface AgentSettings {
  /** Categories in expected adjustment order. */
  groups: SettingGroup[]
  /** Full-access advertised values and permission states that must remain visible. */
  summary: SummarySegment[]
  /** Rendered MCP servers and strict isolation controls. */
  mcp: ReactElement<McpControlProps> | null
  /** The same MCP controls expanded in the composer's full view. */
  mcpPanel: ReactNode
  /** When the CLI does not respond, model choices reduce to the saved setting. */
  catalogError: Error | null
  /** Rereads the catalog past the server cache, offered next to the unavailable notice. */
  refreshCatalog: () => void
}

interface AgentSettingsParams {
  config: AgentConfig
  onConfigChange: (config: AgentConfig) => void
  /**
   * Configuration actually running in the CLI, null before startup or outside an active
   * conversation. Differences from config represent selected settings awaiting restart because live
   * adoption failed.
   */
  appliedConfig?: AgentConfig | null
  /**
   * MCP inventory reported by the running session. Absent outside started conversations, where
   * controls fall back to configured state.
   */
  mcpInventory?: McpServerStatus[]
  disabled?: boolean
  /** False skips the model probe: a draft whose CLI is disabled, missing or not yet known gets only a refusal back. */
  probeModels?: boolean
}

/** Stable reference: a default array literal would retrigger control rendering. */
const NO_INVENTORY: McpServerStatus[] = []

export function useAgentSettings({
  config,
  onConfigChange,
  appliedConfig = null,
  mcpInventory = NO_INVENTORY,
  disabled = false,
  probeModels = true,
}: AgentSettingsParams): AgentSettings {
  const t = useTranslate()
  // Probe only the selected agent: each probe starts its corresponding server-side CLI. Codex and
  // Antigravity list the models of the signed-in plan, so the chosen account selects the catalog.
  const { data: catalog, error: catalogError, isFetching: catalogFetching } = useAgentModels(config.agent, probeModels, modelsAccount(config))
  // A list that lags a login or plan change should not wait an hour of cache: the model panel can reread it.
  const refetchCatalog = useRefreshAgentModels(config.agent, modelsAccount(config))
  const [catalogRefreshing, setCatalogRefreshing] = useState(false)
  const refreshCatalog = useCallback(() => {
    setCatalogRefreshing(true)
    void refetchCatalog().catch(() => undefined).finally(() => setCatalogRefreshing(false))
  }, [refetchCatalog])
  const catalogRefresh = useMemo(() => ({ run: refreshCatalog, busy: catalogRefreshing || catalogFetching }), [refreshCatalog, catalogRefreshing, catalogFetching])

  // Constant configuration copies: TypeScript does not preserve parameter narrowing inside
  // rendering functions built below.
  const claude = config.agent === 'claude' ? config : null
  const codex = config.agent === 'codex' ? config : null
  const opencode = config.agent === 'opencode' ? config : null
  const grok = config.agent === 'grok' ? config : null
  const antigravity = config.agent === 'antigravity' ? config : null

  /**
   * Actually effective model. `CLI_DEFAULT` matches no catalog entry: displaying it directly left
   * an empty selector and no effort choices. Display the model the CLI reports it would choose,
   * while retaining the sentinel in configuration for server-side resolution at conversation
   * creation.
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
        // The hint identifies the actual version behind an alias; Opus alone does not say which
        // generation responds. Add a default reminder only if the label does not already convey it.
        hint: [
          model.description,
          model.hint,
          !named && model.isDefault ? t('composer.model.default') : null,
        ]
          .filter(Boolean)
          .join(' · '),
      }
    })

    // Keep saved models readable and selectable when the catalog cannot load, or the empty select
    // would erase conversation settings. Only preserve actual values, not the sentinel. Old names
    // for still-listed models retain the readable catalog name.
    if (config.model && !known.some((option) => option.value === config.model)) {
      const listed = catalogModel(models, config.model)
      known.unshift({
        value: config.model,
        label: listed?.displayName ?? config.model,
        hint: [listed ? config.model : null, t('composer.select.saved')].filter(Boolean).join(' · '),
      })
    }
    return known
  }, [catalog, config.model, t])

  const effortOptions = useMemo((): SettingChoice<string>[] => {
    const known = effortsFor(catalog?.models, resolvedModel).map((effort) => ({
      value: effort.value,
      label: effortLabel(t, effort),
      hint: effort.hint ?? undefined,
    }))

    // Likewise keep saved effort levels readable and selectable if no longer declared, but only
    // when the model supports effort; otherwise omit the selector.
    const current =
      config.agent === 'claude' ? config.effort : config.agent === 'opencode' ? config.variant : config.reasoningEffort
    if (known.length > 0 && current && !known.some((option) => option.value === current)) {
      known.unshift({ value: current, label: effortLabel(t, { value: current, label: current, hint: null }), hint: t('composer.select.saved') })
    }
    return known
  }, [catalog, config, resolvedModel, t])

  /**
   * Offer fast mode only for eligible accounts and supporting models. Omit rather than disable it,
   * like effort, and omit for CLIs without the concept whose catalog fastMode is null.
   */
  const speedOffered =
    claude !== null &&
    catalog?.fastMode?.available === true &&
    supportsFastMode(catalog.models, resolvedModel)

  /**
   * Ultracode no longer forces xhigh since Claude Code 2.1.284, but still rejects models lacking
   * that level (probed on 2.1.296), so offer it only there like fast mode.
   */
  const supportsUltracode = (model: string): boolean =>
    effortsFor(catalog?.models, model).some((effort) => effort.value === 'xhigh')
  const ultracodeOffered = claude !== null && supportsUltracode(resolvedModel)

  /**
   * CLI response styles after a default entry. Empty configuration means retain the usual style;
   * Radix rejects empty option values, requiring the same display sentinel as approval.
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

  /** Advisor model choices: catalog entries except the nameless default entry, after a none entry. */
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

  /** Same effort sentinel, which only Codex leaves empty: display the selected model's advertised default. */
  const effortSetting = codex ?? grok ?? antigravity
  const resolvedEffort = effortSetting
    ? effortSetting.reasoningEffort ||
      catalogModel(catalog?.models, resolvedModel)?.defaultEffort ||
      CLI_DEFAULT
    : CLI_DEFAULT

  /**
   * Codex-advertised collaboration modes determine accessible tools: Plan mode allows
   * multiple-choice questions otherwise rejected by CLI routing. Source the list from the CLI,
   * omitting it for older versions and CLIs without this concept.
   */
  const codexModeOptions = useMemo((): SettingChoice<CodexMode>[] => {
    // The protocol list is free-form because opencode stores agents there; send only modes
    // recognized by Codex in its configuration.
    return (catalog?.modes ?? []).flatMap((entry) => {
      const mode = codexModeSchema.safeParse(entry.mode)
      return mode.success ? [{ value: mode.data, label: entry.label }] : []
    })
  }, [catalog])

  /**
   * opencode primary agents (build, plan, user-defined), analogous to collaboration modes but with
   * an open list. Keep saved agents selectable even if unlisted.
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
   * Model variants after a default entry: without a variant, opencode retains model settings, a
   * state no named variant represents.
   */
  const variantOptions = useMemo((): SettingChoice<string>[] => {
    if (!opencode || effortOptions.length === 0) return []
    return [
      { value: CLI_DEFAULT_CHOICE, label: t('composer.variant.default'), hint: t('composer.variant.default.hint') },
      ...effortOptions,
    ]
  }, [effortOptions, opencode, t])

  // Approval may be a granular object Sillage cannot edit: display an uneditable option rather than
  // an empty select.
  const approval = config.agent === 'codex' ? config.askForApproval : CLI_DEFAULT
  const granular = typeof approval !== 'string'

  // Radix rejects empty option values: the CLI-decides sentinel needs a display value mapped both ways below.
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
   * Every model has its own effort levels. Retaining unsupported effort after model changes would
   * fail the CLI turn, so use the catalog's advertised fallback.
   */
  const clampEffort = (model: string, current: string): string => {
    if (effortsFor(catalog?.models, model).some((effort) => effort.value === current)) {
      return current
    }
    return catalog?.models.find((entry) => entry.value === model)?.defaultEffort ?? ''
  }

  /** Same fallback narrowed to the protocol enum required by ClaudeConfig.effort. */
  const clampClaudeEffort = (model: string, current: string): ClaudeConfig['effort'] => {
    const parsed = claudeEffortSchema.safeParse(clampEffort(model, current))
    return parsed.success ? parsed.data : DEFAULT_CLAUDE_CONFIG.effort
  }

  /** Current value label. Raw-value fallback covers `CLI_DEFAULT`, absent from named model options. */
  const labelOf = <T extends string>(options: SettingChoice<T>[], value: T): string =>
    options.find((option) => option.value === value)?.label || value || t('composer.select.default')

  /**
   * Summary slot. Tone comes from the selected option rather than a parallel list of dangerous
   * values. Removed safeguards remain visible at every width.
   */
  const segment = <T extends string>(
    key: string,
    options: SettingChoice<T>[],
    value: T,
  ): SummarySegment => {
    const tone = options.find((option) => option.value === value)?.tone
    return { key, label: labelOf(options, value), tone }
  }

  // The registry is instance-wide: React Query caches it instead of requesting for each opened conversation.
  const mcpRegistry = useMcpServers().data
  // Omit when the instance disables the library: ineffective settings should not occupy the panel,
  // like Sillage MCP.
  const libraryAvailable = useSkillLibrary(null).data?.enabled === true
  const libraryOptionList = skillLibraryOptions(t)
  const mcpServers = mcpRegistry?.servers ?? []
  // False until the query responds, like an instance without the server: appear when the registry
  // loads rather than briefly showing and disappearing under the pointer.
  const sillageAvailable = mcpRegistry?.sillageServer === true

  /**
   * Additional Claude accounts for this Sillage account. Request only for Claude and show the
   * category only when there is a choice; otherwise CLI login is implicit.
   */
  const { data: claudeAccountList } = useClaudeAccounts(claude !== null)
  // Codex: only connected accounts are selectable because empty homes would reject turns.
  const { data: codexAccountList } = useCodexAccounts(codex !== null)
  // Grok follows Codex: one home per account, connected or not.
  const { data: grokAccountList } = useGrokAccounts(grok !== null)
  const { data: antigravityAccountList } = useAntigravityAccounts(antigravity !== null)
  const accountOptions = useMemo((): SettingChoice<string>[] => {
    const chosen = claude?.account ?? codex?.account ?? grok?.account ?? antigravity?.account ?? null
    const accounts = claude
      ? (claudeAccountList?.accounts ?? [])
      : codex
        ? (codexAccountList?.accounts ?? []).filter((account) => account.status === 'ready')
        : grok
          ? (grokAccountList?.accounts ?? []).filter((account) => account.status === 'ready')
          : antigravity ? (antigravityAccountList?.accounts ?? []).filter((account) => account.status === 'ready') : null
    if (accounts === null) return []
    if (accounts.length === 0 && !chosen) return []
    const known: SettingChoice<string>[] = [
      { value: CLI_DEFAULT_CHOICE, label: t('composer.account.cli'), hint: t('composer.account.cli.hint') },
      ...accounts.map((account) => ({ value: account.id, label: account.label })),
    ]
    // For deleted accounts still referenced by conversations, the server falls back to CLI login;
    // explain that rather than showing an empty selector.
    if (chosen && !accounts.some((account) => account.id === chosen)) {
      known.push({ value: chosen, label: t('composer.account.missing'), hint: t('composer.select.saved') })
    }
    return known
  }, [claudeAccountList, codexAccountList, grokAccountList, antigravityAccountList, claude, codex, grok, antigravity, t])
  const accountChoice = (account: string | null) => account ?? CLI_DEFAULT_CHOICE

  const permissionOptionList = permissionOptions(t)
  const sandboxOptionList = codexSandboxOptions(t)
  const speedOptionList = speedOptions(t)
  const ultracodeOptionList = ultracodeOptions(t)
  const opencodePermissionList = opencodePermissionOptions(t)
  const grokPermissionList = grokPermissionOptions(t)
  const antigravityPermissionList: SettingChoice<AntigravityConfig['permissionMode']>[] = [
    { value: 'default', label: t('composer.permission.manual'), hint: t('composer.permission.manual.hint') },
    { value: 'auto_edit', label: t('composer.permission.acceptEdits'), hint: t('composer.permission.acceptEdits.hint') },
    { value: 'yolo', label: t('composer.permission.bypass'), hint: t('composer.permission.bypass.hint'), tone: 'caution' },
  ]
  const webSearchOptionList = webSearchOptions(t)

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
            // Retaining fast mode on unsupported models would silently switch the CLI to Opus: reset it with the model.
            fastMode: claude.fastMode && supportsFastMode(catalog?.models, model),
            ultracode: claude.ultracode && supportsUltracode(model),
          }),
      }),
      // Omit rather than disable for models without effort levels: ineffective settings need no panel space.
      ...(effortOptions.length > 0
        ? [
            setting({
              key: 'effort',
              label: t('composer.setting.effort'),
              icon: <Brain size={15} />,
              options: effortOptions,
              value: claude.effort,
              onChange: (effort) => {
                // Options use generic strings; the protocol enum is authoritative and unknown values are not sent.
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
              active: 'fast',
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
              active: 'on',
              value: claude.ultracode ? 'on' : 'off',
              // Independent of effort since CLI 2.1.284: toggling leaves the current effort unchanged.
              onChange: (choice) => onConfigChange({ ...claude, ultracode: choice === 'on' }),
            }),
          ]
        : []),
      ...(accountOptions.length > 0
        ? [
            setting({
              key: 'account',
              label: t('composer.setting.account'),
              icon: <IdCard size={15} />,
              options: accountOptions,
              value: accountChoice(claude.account),
              onChange: (choice) =>
                onConfigChange({ ...claude, account: choice === CLI_DEFAULT_CHOICE ? null : choice }),
              // Tokens arrive through process environment: account changes await session restart like permission mode.
              notice: notice(
                appliedLabel(
                  appliedConfig?.agent === 'claude' ? accountChoice(appliedConfig.account) : undefined,
                  accountChoice(claude.account),
                  accountOptions,
                ),
                t,
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
        // The only panel setting Claude Code cannot change live: entering or leaving allow-all
        // requires restart. Compare CLI too because appliedConfig received during a CLI switch may
        // describe the previous session.
        notice: notice(
          appliedLabel(
            appliedConfig?.agent === 'claude' ? appliedConfig.permissionMode : undefined,
            claude.permissionMode,
            permissionOptionList,
          ),
          t,
        ),
      }),
      setting({
        key: 'budget',
        label: t('composer.setting.budget'),
        icon: <Wallet size={15} />,
        options: budgetOptions(t, claude.maxBudgetUsd),
        value: claude.maxBudgetUsd === null ? 'none' : String(claude.maxBudgetUsd),
        onChange: (budget) => onConfigChange({ ...claude, maxBudgetUsd: budget === 'none' ? null : Number(budget) }),
      }),
      // Omit when the catalog has none, like effort: CLIs without styles or models must not show empty selectors.
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
              active: 'on',
              value: libraryChoice(claude.skillLibrary),
              onChange: (choice) => onConfigChange({ ...claude, skillLibrary: choice === 'on' }),
              // Like permission mode, Claude receives plugins only at launch, so changes await restart.
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
      // Fast mode costs every turn: keep it in the summary while enabled, like removed safeguards.
      ...(speedOffered && claude.fastMode ? [segment('speed', speedOptionList, 'fast')] : []),
      ...(ultracodeOffered && claude.ultracode ? [segment('ultracode', ultracodeOptionList, 'on')] : []),
      // A subscription other than CLI login pays for the turn: show it in the summary.
      ...(claude.account ? [segment('account', accountOptions, claude.account)] : []),
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
      ...(accountOptions.length > 0
        ? [
            setting({
              key: 'account',
              label: t('composer.setting.account'),
              icon: <IdCard size={15} />,
              options: accountOptions,
              value: accountChoice(codex.account),
              onChange: (choice) =>
                onConfigChange({ ...codex, account: choice === CLI_DEFAULT_CHOICE ? null : choice }),
              // Account home is the app-server environment: changes await session restart.
              notice: notice(
                appliedLabel(
                  appliedConfig?.agent === 'codex' ? accountChoice(appliedConfig.account) : undefined,
                  accountChoice(codex.account),
                  accountOptions,
                ),
                t,
              ),
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
          // granular is only a display marker, never selectable or sent to the server.
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
      // Applied live by Codex, so no pending annotation.
      ...(libraryAvailable
        ? [
            setting({
              key: 'skillLibrary',
              label: t('composer.setting.skillLibrary'),
              icon: <BookOpen size={15} />,
              options: libraryOptionList,
              active: 'on',
              value: libraryChoice(codex.skillLibrary),
              onChange: (choice) => onConfigChange({ ...codex, skillLibrary: choice === 'on' }),
            }),
          ]
        : []),
    ]

    // Removed approval and sandbox safeguards remain visible simultaneously.
    const approvalOff = approvalValue === 'never'
    summary = [
      segment('model', modelOptions, resolvedModel),
      ...(effortOptions.length > 0 ? [segment('effort', effortOptions, resolvedEffort)] : []),
      ...(codex.account ? [segment('account', accountOptions, codex.account)] : []),
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
        // Unsupported variants after model changes fall back to the new model's own settings, which always exist.
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
      // opencode reads rules at launch: like Claude permission mode, changes await restart and the
      // row explains the currently effective rule.
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
              active: 'on',
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

    // Name the family in summaries: Allow alone does not say what. Unrestricted families stay
    // visible like any removed safeguard; two ask rules summarize in one word.
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
  } else if (grok) {
    const applied = appliedConfig?.agent === 'grok' ? appliedConfig : null
    const webSearch: WebSearchChoice = grok.webSearch ? 'on' : 'off'

    groups = [
      setting({
        key: 'model',
        label: t('composer.setting.model'),
        icon: <Sparkles size={15} />,
        options: modelOptions,
        value: resolvedModel,
        onChange: (model) =>
          onConfigChange({ ...grok, model, reasoningEffort: clampEffort(model, grok.reasoningEffort) }),
      }),
      ...(effortOptions.length > 0
        ? [
            setting({
              key: 'effort',
              label: t('composer.setting.effort'),
              icon: <Brain size={15} />,
              options: effortOptions,
              value: resolvedEffort,
              onChange: (reasoningEffort) => onConfigChange({ ...grok, reasoningEffort }),
            }),
          ]
        : []),
      setting({
        key: 'permission',
        label: t('composer.setting.permission'),
        icon: <ShieldCheck size={15} />,
        options: grokPermissionList,
        value: grok.permissionMode,
        onChange: (permissionMode) => onConfigChange({ ...grok, permissionMode }),
      }),
      ...(accountOptions.length > 0
        ? [
            setting({
              key: 'account',
              label: t('composer.setting.account'),
              icon: <IdCard size={15} />,
              options: accountOptions,
              value: accountChoice(grok.account),
              onChange: (choice) =>
                onConfigChange({ ...grok, account: choice === CLI_DEFAULT_CHOICE ? null : choice }),
              // Account identifies process GROK_HOME: changes await session restart.
              notice: notice(
                appliedLabel(applied ? accountChoice(applied.account) : undefined, accountChoice(grok.account), accountOptions),
                t,
              ),
            }),
          ]
        : []),
      // Grok disables web tools through a launch option: changes await restart and the row explains
      // the current state.
      setting({
        key: 'webSearch',
        label: t('composer.setting.webSearch'),
        icon: <Globe size={15} />,
        options: webSearchOptionList,
        active: 'on',
        value: webSearch,
        onChange: (choice) => onConfigChange({ ...grok, webSearch: choice === 'on' }),
        notice: notice(
          appliedLabel(applied ? (applied.webSearch ? 'on' : 'off') : undefined, webSearch, webSearchOptionList),
          t,
        ),
      }),
      ...(libraryAvailable
        ? [
            setting({
              key: 'skillLibrary',
              label: t('composer.setting.skillLibrary'),
              icon: <BookOpen size={15} />,
              options: libraryOptionList,
              active: 'on',
              value: libraryChoice(grok.skillLibrary),
              onChange: (choice) => onConfigChange({ ...grok, skillLibrary: choice === 'on' }),
              // Skills arrive as plugins at process launch, like Claude.
              notice: notice(
                appliedLabel(
                  applied ? libraryChoice(applied.skillLibrary) : undefined,
                  libraryChoice(grok.skillLibrary),
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
      ...(effortOptions.length > 0 ? [segment('effort', effortOptions, resolvedEffort)] : []),
      ...(grok.account ? [segment('account', accountOptions, grok.account)] : []),
      segment('permission', grokPermissionList, grok.permissionMode),
    ]

    mcp = (
      <McpControl
        servers={mcpServers}
        inventory={mcpInventory}
        selected={grok.mcpServers}
        onSelectedChange={(ids) => onConfigChange({ ...grok, mcpServers: ids })}
        sillage={sillageAvailable ? grok.sillageMcp : null}
        onSillageChange={(sillageMcp) => onConfigChange({ ...grok, sillageMcp })}
        strict={null}
        onStrictChange={() => {}}
        disabled={disabled}
      />
    )
  } else if (antigravity) {
    const applied = appliedConfig?.agent === 'antigravity' ? appliedConfig : null

    groups = [
      setting({
        key: 'model',
        label: t('composer.setting.model'),
        icon: <Sparkles size={15} />,
        options: modelOptions,
        value: resolvedModel,
        onChange: (model) =>
          onConfigChange({ ...antigravity, model, reasoningEffort: clampEffort(model, antigravity.reasoningEffort) }),
      }),
      ...(effortOptions.length > 0
        ? [
            setting({
              key: 'effort',
              label: t('composer.setting.effort'),
              icon: <Brain size={15} />,
              options: effortOptions,
              value: resolvedEffort,
              onChange: (reasoningEffort) => onConfigChange({ ...antigravity, reasoningEffort }),
            }),
          ]
        : []),
      setting({
        key: 'permission',
        label: t('composer.setting.permission'),
        icon: <ShieldCheck size={15} />,
        options: antigravityPermissionList,
        value: antigravity.permissionMode,
        onChange: (permissionMode) => onConfigChange({ ...antigravity, permissionMode }),
      }),
      ...(accountOptions.length > 0
        ? [
            setting({
              key: 'account',
              label: t('composer.setting.account'),
              icon: <IdCard size={15} />,
              options: accountOptions,
              value: accountChoice(antigravity.account),
              onChange: (choice) =>
                onConfigChange({ ...antigravity, account: choice === CLI_DEFAULT_CHOICE ? null : choice, model: '', reasoningEffort: '' }),
              // Account identifies process GEMINI_HOME: changes await session restart.
              notice: notice(
                appliedLabel(applied ? accountChoice(applied.account) : undefined, accountChoice(antigravity.account), accountOptions),
                t,
              ),
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
              active: 'on',
              value: libraryChoice(antigravity.skillLibrary),
              onChange: (choice) => onConfigChange({ ...antigravity, skillLibrary: choice === 'on' }),
              // Native skill discovery runs when the process starts.
              notice: notice(
                appliedLabel(
                  applied ? libraryChoice(applied.skillLibrary) : undefined,
                  libraryChoice(antigravity.skillLibrary),
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
      ...(effortOptions.length > 0 ? [segment('effort', effortOptions, resolvedEffort)] : []),
      ...(antigravity.account ? [segment('account', accountOptions, antigravity.account)] : []),
      segment('permission', antigravityPermissionList, antigravity.permissionMode),
    ]

    mcp = (
      <McpControl
        servers={mcpServers}
        inventory={mcpInventory}
        selected={antigravity.mcpServers}
        onSelectedChange={(ids) => onConfigChange({ ...antigravity, mcpServers: ids })}
        sillage={sillageAvailable ? antigravity.sillageMcp : null}
        onSillageChange={(sillageMcp) => onConfigChange({ ...antigravity, sillageMcp })}
        strict={null}
        onStrictChange={() => {}}
        disabled={disabled}
      />
    )
  }

  groups = groups.map((group) => (group.key === 'model' ? { ...group, refresh: catalogRefresh } : group))
  return { groups, summary, mcp, mcpPanel: mcp ? cloneElement(mcp, { presentation: 'panel' }) : null, catalogError, refreshCatalog }
}
