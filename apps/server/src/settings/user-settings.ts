import { eq } from 'drizzle-orm'
import { userSettings, type Db } from '@sillage/db'
import {
  DEFAULT_ONBOARDING,
  storedUserSettingsSchema,
  type AgentConfig,
  type AppearancePrefs,
  type ComposerLayout,
  type NotificationPrefs,
  type OnboardingState,
  type UserSettingsDto,
} from '@sillage/protocol'

export type UserSettings = UserSettingsDto

/**
 * Les réglages d'un compte, défauts du protocole compris.
 *
 * Une seule ligne par compte, la charge étant un objet JSON : ces réglages n'ont ni
 * requête à filtrer ni jointure à faire, et une colonne par réglage ajouté imposerait
 * une migration à chaque nouvelle case à cocher.
 *
 * Relu à chaque appel, comme les réglages d'instance : on y passe à l'ouverture d'un
 * écran ou à la création d'une conversation, jamais dans un chemin chaud.
 */
export function readUserSettings(db: Db, userId: string): UserSettings {
  const row = db.select().from(userSettings).where(eq(userSettings.userId, userId)).get()
  return storedUserSettingsSchema.parse(parseData(row?.data))
}

/**
 * Remplace le défaut d'un CLI sans toucher à celui de l'autre.
 *
 * La ligne est relue avant d'être réécrite : la charge JSON portera d'autres réglages,
 * et un `insert` bâti sur le seul corps de la requête les effacerait.
 */
export function writeUserAgentDefault(db: Db, userId: string, config: AgentConfig): void {
  const current = readUserSettings(db, userId)
  const data = JSON.stringify({
    ...current,
    agentDefaults: {
      ...current.agentDefaults,
      // Les répertoires supplémentaires désignent des dossiers d'un projet précis :
      // les figer dans un défaut de compte les emmènerait dans des conversations qui
      // n'ont rien à voir.
      [config.agent]: { ...config, additionalDirectories: [] },
    },
  })

  db.insert(userSettings)
    .values({ userId, data })
    .onConflictDoUpdate({ target: userSettings.userId, set: { data } })
    .run()
}

/**
 * Les projets repliés dans la sidebar, remplacés en bloc.
 *
 * La liste entière et non un identifiant à basculer : c'est un état d'affichage que le
 * client connaît déjà en entier, et une bascule côté serveur ferait dépendre le résultat
 * de l'ordre d'arrivée de deux onglets ouverts sur la même sidebar.
 */
export function writeCollapsedProjects(db: Db, userId: string, projectIds: string[]): void {
  const current = readUserSettings(db, userId)
  const data = JSON.stringify({ ...current, collapsedProjects: [...new Set(projectIds)] })

  db.insert(userSettings)
    .values({ userId, data })
    .onConflictDoUpdate({ target: userSettings.userId, set: { data } })
    .run()
}

/**
 * L'état de la visite, remplacé en bloc.
 *
 * Appelé aussi à la création d'un compte, pour l'armer : c'est la seule façon pour un
 * compte d'avoir la visite due, les comptes d'avant la visite ne la voyant jamais.
 */
export function writeOnboarding(db: Db, userId: string, onboarding: OnboardingState): void {
  const current = readUserSettings(db, userId)
  const data = JSON.stringify({ ...current, onboarding })

  db.insert(userSettings)
    .values({ userId, data })
    .onConflictDoUpdate({ target: userSettings.userId, set: { data } })
    .run()
}

/** La visite due, à sa première étape : ce qu'un compte reçoit en naissant. */
export function armOnboarding(db: Db, userId: string): void {
  writeOnboarding(db, userId, { ...DEFAULT_ONBOARDING, pending: true })
}

/** Le dossier parent proposé à la prochaine création de projet, ou `null` pour l'oublier. */
export function writeProjectsDir(db: Db, userId: string, projectsDir: string | null): void {
  const current = readUserSettings(db, userId)
  const data = JSON.stringify({ ...current, projectsDir })

  db.insert(userSettings)
    .values({ userId, data })
    .onConflictDoUpdate({ target: userSettings.userId, set: { data } })
    .run()
}

/** Thème et curseurs, remplacés en bloc : l'interface envoie toujours l'état complet. */
export function writeAppearance(db: Db, userId: string, appearance: AppearancePrefs): void {
  const current = readUserSettings(db, userId)
  const data = JSON.stringify({ ...current, appearance })

  db.insert(userSettings)
    .values({ userId, data })
    .onConflictDoUpdate({ target: userSettings.userId, set: { data } })
    .run()
}

/** Les sortes de notifications voulues, remplacées en bloc comme l'apparence. */
export function writeNotificationPrefs(db: Db, userId: string, notifications: NotificationPrefs): void {
  const current = readUserSettings(db, userId)
  const data = JSON.stringify({ ...current, notifications })

  db.insert(userSettings)
    .values({ userId, data })
    .onConflictDoUpdate({ target: userSettings.userId, set: { data } })
    .run()
}

/** Les réglages épinglés sous le composer, par CLI, remplacés en bloc. */
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
    // Une charge illisible vaut absente : les défauts reprennent la main, et la
    // prochaine écriture depuis l'interface la remplacera.
    return {}
  }
}
