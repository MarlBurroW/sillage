import { eq } from 'drizzle-orm'
import { userSettings, type Db } from '@sillage/db'
import {
  DEFAULT_ONBOARDING,
  storedUserSettingsSchema,
  type AgentConfig,
  type AgentKind,
  type AppearancePrefs,
  type BoardOrder,
  type ComposerLayout,
  type NotificationPrefs,
  type OnboardingState,
  type ProjectDefaults,
  type UserSettingsDto,
  type NewsPreferences,
} from '@sillage/protocol'

export type UserSettings = UserSettingsDto

/** Account settings including protocol defaults. One JSON row per account: settings need neither filtering nor joins, and individual columns would require migrations for every new checkbox. Reread on every call like instance settings; used when opening screens or creating conversations, never on hot paths. */
export function readUserSettings(db: Db, userId: string): UserSettings {
  const row = db.select().from(userSettings).where(eq(userSettings.userId, userId)).get()
  return storedUserSettingsSchema.parse(parseData(row?.data))
}

/** Replaces one CLI's defaults without affecting the other. Reread before rewriting: JSON will contain other settings, and inserts based solely on request bodies would erase them. */
export function writeUserAgentDefault(db: Db, userId: string, config: AgentConfig): void {
  const current = readUserSettings(db, userId)
  const data = JSON.stringify({
    ...current,
    agentDefaults: {
      ...current.agentDefaults,
      // Additional directories belong to specific projects:
      // fixing them in account defaults would carry them into
      // unrelated conversations.
      [config.agent]: { ...config, additionalDirectories: [] },
    },
  })

  db.insert(userSettings)
    .values({ userId, data })
    .onConflictDoUpdate({ target: userSettings.userId, set: { data } })
    .run()
}

/** Replaces the whole set of collapsed sidebar projects. Send the entire client-known display state rather than an ID to toggle: server-side toggling would make results depend on arrival order from tabs sharing the sidebar. */
export function writeCollapsedProjects(db: Db, userId: string, projectIds: string[]): void {
  const current = readUserSettings(db, userId)
  const data = JSON.stringify({ ...current, collapsedProjects: [...new Set(projectIds)] })

  db.insert(userSettings)
    .values({ userId, data })
    .onConflictDoUpdate({ target: userSettings.userId, set: { data } })
    .run()
}

/** Project board order without affecting other projects. */
export function writeBoardOrder(db: Db, userId: string, projectId: string, order: BoardOrder): void {
  const current = readUserSettings(db, userId)
  const boardOrder = { ...current.boardOrder }
  // Manual order is the default; storing it would only enlarge the payload.
  if (order === 'manual') delete boardOrder[projectId]
  else boardOrder[projectId] = order
  const data = JSON.stringify({ ...current, boardOrder })

  db.insert(userSettings)
    .values({ userId, data })
    .onConflictDoUpdate({ target: userSettings.userId, set: { data } })
    .run()
}

/** Replaces the set of CLIs hidden while missing, like collapsed projects. */
export function writeHiddenAgents(db: Db, userId: string, agents: AgentKind[]): void {
  const current = readUserSettings(db, userId)
  const data = JSON.stringify({ ...current, hiddenAgents: [...new Set(agents)] })

  db.insert(userSettings)
    .values({ userId, data })
    .onConflictDoUpdate({ target: userSettings.userId, set: { data } })
    .run()
}

/** Replaces the whole tour state. Also called during account creation to make the tour due: this is the only way to schedule it, so accounts predating the tour never see it. */
export function writeOnboarding(db: Db, userId: string, onboarding: OnboardingState): void {
  const current = readUserSettings(db, userId)
  const data = JSON.stringify({ ...current, onboarding })

  db.insert(userSettings)
    .values({ userId, data })
    .onConflictDoUpdate({ target: userSettings.userId, set: { data } })
    .run()
}

/** Replaces all defaults for future projects. */
export function writeProjectDefaults(db: Db, userId: string, projectDefaults: ProjectDefaults): void {
  const current = readUserSettings(db, userId)
  const data = JSON.stringify({ ...current, projectDefaults })

  db.insert(userSettings)
    .values({ userId, data })
    .onConflictDoUpdate({ target: userSettings.userId, set: { data } })
    .run()
}

/** Initial due tour state at its first step, assigned to new accounts. */
export function armOnboarding(db: Db, userId: string): void {
  writeOnboarding(db, userId, { ...DEFAULT_ONBOARDING, pending: true })
}

/** Parent directory suggested for the next project, or `null` to forget it. */
export function writeProjectsDir(db: Db, userId: string, projectsDir: string | null): void {
  const current = readUserSettings(db, userId)
  const data = JSON.stringify({ ...current, projectsDir })

  db.insert(userSettings)
    .values({ userId, data })
    .onConflictDoUpdate({ target: userSettings.userId, set: { data } })
    .run()
}

/** Replaces theme and sliders together: the interface always sends complete state. */
export function writeAppearance(db: Db, userId: string, appearance: AppearancePrefs): void {
  const current = readUserSettings(db, userId)
  const data = JSON.stringify({ ...current, appearance })

  db.insert(userSettings)
    .values({ userId, data })
    .onConflictDoUpdate({ target: userSettings.userId, set: { data } })
    .run()
}

/** Replaces notification preferences together, like appearance. */
export function writeNotificationPrefs(db: Db, userId: string, notifications: NotificationPrefs): void {
  const current = readUserSettings(db, userId)
  const data = JSON.stringify({ ...current, notifications })

  db.insert(userSettings)
    .values({ userId, data })
    .onConflictDoUpdate({ target: userSettings.userId, set: { data } })
    .run()
}

/** Replaces settings pinned below the composer, per CLI. */
export function writeComposerLayout(db: Db, userId: string, composerLayout: ComposerLayout): void {
  const current = readUserSettings(db, userId)
  const data = JSON.stringify({ ...current, composerLayout })

  db.insert(userSettings)
    .values({ userId, data })
    .onConflictDoUpdate({ target: userSettings.userId, set: { data } })
    .run()
}

function parseData(data: string | undefined): unknown {
  if (!data) return {}

  try {
    return JSON.parse(data)
  } catch {
    // Treat unreadable payloads as absent: defaults take over and the next
    // interface write replaces them.
    return {}
  }
}

export function writeNewsPreferences(db: Db, userId: string, news: NewsPreferences): void {
  const data = JSON.stringify({ ...readUserSettings(db, userId), news })
  db.insert(userSettings).values({ userId, data })
    .onConflictDoUpdate({ target: userSettings.userId, set: { data } }).run()
}
