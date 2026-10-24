import { DEFAULT_NEWS_PREFERENCES, newsPreferencesSchema, type NewsPreferences } from './news.js'
import { z } from 'zod'
import { agentKindSchema, type AgentKind } from './events.js'
import { instructionsModeSchema } from './instructions.js'
import { memoryModeSchema, type MemoryMode } from './memory.js'
import { DEFAULT_NOTIFICATION_PREFS, notificationPrefsSchema, type NotificationPrefs } from './notifications.js'
import {
  agentConfigSchema,
  claudeConfigSchema,
  codexConfigSchema,
  opencodeConfigSchema,
  grokConfigSchema,
  antigravityConfigSchema,
  DEFAULT_CLAUDE_CONFIG,
  DEFAULT_CODEX_CONFIG,
  DEFAULT_OPENCODE_CONFIG,
  DEFAULT_GROK_CONFIG,
  DEFAULT_ANTIGRAVITY_CONFIG,
  type ClaudeConfig,
  type CodexConfig,
  type OpencodeConfig,
  type GrokConfig,
  type AntigravityConfig,
} from './agent-config.js'

/**
 * Account-specific settings, as opposed to instance settings.
 *
 * They describe a starting point, not server behavior: how conversations open when nothing else
 * is specified. Two people in one project may thus use different safeguards, intentionally:
 * permission mode concerns whoever reads the answers, not the instance.
 */
/**
 * Card order within a column: `manual` follows drag and drop, `recent` puts the latest arrival
 * first, `oldest` puts the earliest first (a queue).
 */
export const boardOrderSchema = z.enum(['manual', 'recent', 'oldest'])
export type BoardOrder = z.infer<typeof boardOrderSchema>

export interface UserSettingsDto {
  news: NewsPreferences
  agentDefaults: AgentDefaults
  /**
   * Collapsed sidebar projects.
   *
   * Track collapsed rather than expanded projects so new projects open expanded without needing
   * to be added to a list.
   *
   * Stored per account rather than browser, unlike width or a project's home screen: collapsing
   * a project means it is not currently being worked on, still true after switching machines or
   * opening the phone app.
   */
  collapsedProjects: string[]
  /**
   * CLIs to hide while uninstalled.
   *
   * Someone using only Claude Code need not see three “Install” buttons for every new session.
   * Hiding is not disabling: a hidden CLI reappears if installed, and one click reopens the
   * list. Account-level, like collapsed projects, so the choice applies across devices.
   */
  hiddenAgents: AgentKind[]
  /**
   * Per-project board-column ordering: manual (drag and drop), latest arrival first or earliest
   * arrival first. Absent defaults to manual. Account-level rather than project-level: it is a
   * way to read the board, not a rule one member imposes on others.
   */
  boardOrder: Record<string, BoardOrder>
  /**
   * Suggested parent directory for project creation; `null` until a project has been created
   * this way.
   *
   * Remembered on every creation rather than configured separately: people store projects in
   * the same place, and the first creation establishes it.
   */
  projectsDir: string | null
  /**
   * Theme and appearance settings; `null` until this account saves any.
   *
   * Account-level for the same reason as collapsed projects: colors follow device changes. The
   * browser keeps a copy read before hydration to prevent flashing, but this value is
   * authoritative.
   *
   * `null` rather than defaults allows first load to upload existing browser settings instead
   * of overwriting them.
   */
  appearance: AppearancePrefs | null
  /** Notification kinds this account wants across all devices. */
  notifications: NotificationPrefs
  /**
   * Settings pinned below the composer per CLI, in addition to the permanent model/effort chip.
   * Desktop screens only; phones retain only the chip.
   *
   * Category keys (`ultracode`, `permission`, etc.) in display order, not values: pinning
   * exposes a control while the setting remains in the conversation. Per CLI because categories
   * do not map across CLIs, like defaults. Account-level so the bar follows device changes,
   * like collapsed projects.
   */
  composerLayout: ComposerLayout
  /**
   * First-open tour and its progress.
   *
   * Account-level rather than browser-level: onboarding configures the account (agents,
   * appearance, instructions), so resuming on another device must continue at the right step.
   */
  onboarding: OnboardingState
  /**
   * Defaults for new projects created by this account when creation specifies nothing.
   *
   * Account-level, not instance-wide: instruction and memory storage are personal working
   * preferences, like permission mode.
   */
  projectDefaults: ProjectDefaults
}

/**
 * `auto` instructions: use the repository if it already has `AGENTS.md` or `CLAUDE.md`,
 * otherwise Sillage, matching the server's previous automatic behavior.
 */
export interface ProjectDefaults {
  instructionsMode: 'auto' | 'sillage' | 'repo'
  memoryMode: MemoryMode
}

export const DEFAULT_PROJECT_DEFAULTS: ProjectDefaults = { instructionsMode: 'auto', memoryMode: 'sillage' }

export const projectDefaultsSchema = z.object({
  instructionsMode: z.union([z.literal('auto'), instructionsModeSchema]).default('auto').catch('auto'),
  memoryMode: memoryModeSchema.default('sillage').catch('sillage'),
})

/**
 * Initial onboarding answers determining subsequent steps.
 *
 * `agents` filters the agents step; `devices` adds the phone step; `team` adds project
 * visibility; `guidance` controls explanation detail. `permission` records the chosen default
 * approach for the recap.
 */
export interface OnboardingAnswers {
  agents: AgentKind[]
  /**
   * True once the user interacts with the agents question. Before then, an empty list means
   * nothing, and the UI automatically selects CLIs found on the machine.
   */
  agentsChosen: boolean
  team: 'solo' | 'team'
  devices: 'computer' | 'phone'
  guidance: 'guided' | 'direct'
  permission: 'manual' | 'auto' | 'acceptEdits' | 'bypass'
}

export interface OnboardingState {
  /**
   * True while onboarding is due. Defaults to false so older accounts do not unexpectedly see
   * it on their next login; account creation and “Replay tour” in settings enable it.
   */
  pending: boolean
  /** Current step index in the list the UI derives from answers. */
  step: number
  answers: OnboardingAnswers
  /** IDs of steps skipped with “Later”, for the recap. */
  skipped: string[]
  /**
   * IDs of visited steps, continued or skipped: users can revisit them from the list in either
   * direction without repeating intermediate steps.
   */
  visited: string[]
}

export const DEFAULT_ONBOARDING_ANSWERS: OnboardingAnswers = {
  agents: [],
  agentsChosen: false,
  team: 'solo',
  devices: 'phone',
  guidance: 'guided',
  permission: 'auto',
}

export const DEFAULT_ONBOARDING: OnboardingState = {
  pending: false,
  step: 0,
  answers: DEFAULT_ONBOARDING_ANSWERS,
  skipped: [],
  visited: [],
}

export const onboardingAnswersSchema = z.object({
  agents: z.array(agentKindSchema).max(agentKindSchema.options.length).default([]).catch([]),
  agentsChosen: z.boolean().default(false).catch(false),
  team: z.enum(['solo', 'team']).default('solo').catch('solo'),
  devices: z.enum(['computer', 'phone']).default('phone').catch('phone'),
  guidance: z.enum(['guided', 'direct']).default('guided').catch('guided'),
  permission: z.enum(['manual', 'auto', 'acceptEdits', 'bypass']).default('auto').catch('auto'),
})

export const onboardingStateSchema = z.object({
  pending: z.boolean().default(false).catch(false),
  step: z.number().int().min(0).max(32).default(0).catch(0),
  answers: onboardingAnswersSchema.default(DEFAULT_ONBOARDING_ANSWERS).catch(DEFAULT_ONBOARDING_ANSWERS),
  skipped: z.array(z.string().max(40)).max(32).default([]).catch([]),
  visited: z.array(z.string().max(40)).max(32).default([]).catch([]),
})

/**
 * Pinned category keys per CLI. Unknown keys are ignored on display, as are `model` and
 * `effort` saved by earlier versions.
 */
export interface ComposerLayout {
  claude: string[]
  codex: string[]
  opencode: string[]
  grok: string[]
  antigravity: string[]
}

/** Nothing pinned: only the model/effort chip. */
export const DEFAULT_COMPOSER_LAYOUT: ComposerLayout = {
  claude: [],
  codex: [],
  opencode: [],
  grok: [],
  antigravity: [],
}

/** A category key as named by `agent-settings`, with no longer values allowed. */
const pinnedKeysSchema = z.array(z.string().min(1).max(40)).max(16)

export const composerLayoutSchema = z.object({
  claude: pinnedKeysSchema.default(DEFAULT_COMPOSER_LAYOUT.claude).catch(DEFAULT_COMPOSER_LAYOUT.claude),
  codex: pinnedKeysSchema.default(DEFAULT_COMPOSER_LAYOUT.codex).catch(DEFAULT_COMPOSER_LAYOUT.codex),
  opencode: pinnedKeysSchema.default(DEFAULT_COMPOSER_LAYOUT.opencode).catch(DEFAULT_COMPOSER_LAYOUT.opencode),
  grok: pinnedKeysSchema.default(DEFAULT_COMPOSER_LAYOUT.grok).catch(DEFAULT_COMPOSER_LAYOUT.grok),
  antigravity: pinnedKeysSchema.default(DEFAULT_COMPOSER_LAYOUT.antigravity).catch(DEFAULT_COMPOSER_LAYOUT.antigravity),
})

/**
 * The server knows neither themes nor sliders: it stores UI-provided data within size limits.
 * Removed theme names fall back to the client default.
 */
export interface AppearancePrefs {
  theme: string | null
  syntax: string | null
  /** Absent on older accounts: the UI uses the Sillage logo. */
  typingIndicator?: string | null
  toolStyle?: string | null
  /** Slider values keyed by setting name (`hue`, `tint`, `readingSize`, etc.). */
  values: Record<string, number>
}

/**
 * Complete defaults per CLI, never shared defaults.
 *
 * Same reason as `AgentConfig`: Claude permission modes and Codex approval/sandbox pairs do not
 * map onto each other; a single setting would invent that mapping.
 */
export interface AgentDefaults {
  claude: ClaudeConfig
  codex: CodexConfig
  opencode: OpencodeConfig
  grok: GrokConfig
  antigravity: AntigravityConfig
}

export const DEFAULT_AGENT_DEFAULTS: AgentDefaults = {
  claude: DEFAULT_CLAUDE_CONFIG,
  codex: DEFAULT_CODEX_CONFIG,
  opencode: DEFAULT_OPENCODE_CONFIG,
  grok: DEFAULT_GROK_CONFIG,
  antigravity: DEFAULT_ANTIGRAVITY_CONFIG,
}

/**
 * Reads stored account settings.
 *
 * Tolerant at every level: newly added settings, protocol values since removed or half-written
 * records fall back to CLI defaults instead of making settings unreadable. These are
 * conversation starting points; none warrants an error.
 */
export const agentDefaultsSchema = z.object({
  claude: claudeConfigSchema.catch(DEFAULT_CLAUDE_CONFIG),
  codex: codexConfigSchema.catch(DEFAULT_CODEX_CONFIG),
  // `default` as well as `catch`: settings predating opencode lack the key.
  opencode: opencodeConfigSchema.default(DEFAULT_OPENCODE_CONFIG).catch(DEFAULT_OPENCODE_CONFIG),
  grok: grokConfigSchema.default(DEFAULT_GROK_CONFIG).catch(DEFAULT_GROK_CONFIG),
  antigravity: antigravityConfigSchema.default(DEFAULT_ANTIGRAVITY_CONFIG).catch(DEFAULT_ANTIGRAVITY_CONFIG),
})

export const appearancePrefsSchema = z.object({
  theme: z.string().max(40).nullable(),
  syntax: z.string().max(40).nullable(),
  typingIndicator: z.string().max(40).nullable().optional(),
  toolStyle: z.string().max(40).nullable().optional(),
  values: z
    .record(z.string().max(40), z.number().finite())
    .refine((values) => Object.keys(values).length <= 32),
})

export const storedUserSettingsSchema = z
  .object({
    news: newsPreferencesSchema.default(DEFAULT_NEWS_PREFERENCES).catch(DEFAULT_NEWS_PREFERENCES),
    agentDefaults: agentDefaultsSchema.catch(DEFAULT_AGENT_DEFAULTS),
    // Never purged of deleted projects: unknown IDs cost readers nothing,
    // while cleanup would require touching these settings on every deletion,
    // including for accounts that no longer sign in.
    collapsedProjects: z.array(z.string()).default([]).catch([]),
    hiddenAgents: z.array(agentKindSchema).default([]).catch([]),
    boardOrder: z.record(z.string(), boardOrderSchema).default({}).catch({}),
    projectsDir: z.string().nullable().default(null).catch(null),
    appearance: appearancePrefsSchema.nullable().default(null).catch(null),
    notifications: notificationPrefsSchema.default(DEFAULT_NOTIFICATION_PREFS).catch(DEFAULT_NOTIFICATION_PREFS),
    composerLayout: composerLayoutSchema.default(DEFAULT_COMPOSER_LAYOUT).catch(DEFAULT_COMPOSER_LAYOUT),
    onboarding: onboardingStateSchema.default(DEFAULT_ONBOARDING).catch(DEFAULT_ONBOARDING),
    projectDefaults: projectDefaultsSchema.default(DEFAULT_PROJECT_DEFAULTS).catch(DEFAULT_PROJECT_DEFAULTS),
  })
  .catch({
    news: DEFAULT_NEWS_PREFERENCES,
    agentDefaults: DEFAULT_AGENT_DEFAULTS,
    collapsedProjects: [],
    hiddenAgents: [],
    boardOrder: {},
    projectsDir: null,
    appearance: null,
    notifications: DEFAULT_NOTIFICATION_PREFS,
    composerLayout: DEFAULT_COMPOSER_LAYOUT,
    onboarding: DEFAULT_ONBOARDING,
    projectDefaults: DEFAULT_PROJECT_DEFAULTS,
  })

export const updateUserSettingsBodySchema = z.object({
  /**
   * Defaults for one CLI, identified by the configuration discriminant. Other CLIs retain their
   * values: the screen edits one at a time, and sending both could overwrite changes made by
   * another tab.
   */
  agentDefault: agentConfigSchema.optional(),
  /** Whole list: display state, not an opening-history log. */
  collapsedProjects: z.array(z.string().uuid()).optional(),
  /** Whole list, for the same reason. */
  hiddenAgents: z.array(agentKindSchema).optional(),
  /** Order for one board; other projects keep theirs. */
  boardOrder: z.object({ projectId: z.string().uuid(), order: boardOrderSchema }).optional(),
  /** `null` clears the remembered directory; absent leaves it unchanged. */
  projectsDir: z.string().min(1).nullable().optional(),
  /** Replaced wholesale, like collapsed projects. */
  appearance: appearancePrefsSchema.optional(),
  notifications: notificationPrefsSchema.optional(),
  /** Also replaced wholesale: the UI knows the CLI's entire list. */
  composerLayout: composerLayoutSchema.optional(),
  /** Replaced wholesale: onboarding knows its complete state at every step. */
  onboarding: onboardingStateSchema.optional(),
  /** Replaced wholesale: two choices always made together. */
  projectDefaults: projectDefaultsSchema.optional(),
})
