import { eq } from 'drizzle-orm'
import { userSettings, type Db } from '@sillage/db'
import {
  storedUserSettingsSchema,
  type AgentConfig,
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
