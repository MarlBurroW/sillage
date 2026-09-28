import { createContext, useContext, useEffect, useSyncExternalStore } from 'react'
import { api } from './api'
import { workspaceApiBase, type WorkspaceScope } from './workspace-scope'

/**
 * Chemins cités dans le fil dont on sait qu'ils désignent un fichier du workspace.
 *
 * Les messages sont rendus un par un, chacun avec ses candidats, mais les interroger un
 * par un ferait autant de requêtes que de messages à l'ouverture d'une conversation. Les
 * candidats sont donc rassemblés sur une micro-tâche, soumis en un lot, et la réponse
 * alimente une table partagée par tout le fil : un chemin cité dix fois n'est vérifié
 * qu'une seule.
 *
 * Hors de React et hors du cache de requêtes parce que la clé n'est pas un écran mais un
 * ensemble de chemins qui s'agrandit à mesure qu'on défile.
 */

/** Doit rester sous la limite de `filesExistBodySchema`. */
const BATCH_LIMIT = 50

interface Resolution {
  /** Chemins confirmés comme fichiers. */
  readonly files: Set<string>
  /** Chemins déjà soumis, confirmés ou non, pour ne pas les redemander. */
  readonly asked: Set<string>
}

const byScope = new Map<string, Resolution>()
const pending = new Map<string, Set<string>>()
const listeners = new Set<() => void>()

const EMPTY: Set<string> = new Set()

function resolutionOf(scope: WorkspaceScope): Resolution {
  const current = byScope.get(scope)
  if (current) return current
  const created: Resolution = { files: new Set(), asked: new Set() }
  byScope.set(scope, created)
  return created
}

function emit(): void {
  for (const listener of listeners) listener()
}

async function flush(scope: WorkspaceScope): Promise<void> {
  const queued = pending.get(scope)
  pending.delete(scope)
  if (!queued || queued.size === 0) return

  const resolution = resolutionOf(scope)
  const paths = [...queued].slice(0, BATCH_LIMIT)
  for (const path of paths) resolution.asked.add(path)

  const answer = await api
    .post<{ files: string[] }>(`${workspaceApiBase(scope)}/files/exist`, { paths })
    // Un lien manquant n'est pas une panne à signaler : le chemin reste du texte, ce
    // qu'il était avant. Les chemins restent marqués comme demandés, sinon chaque
    // rendu relancerait la requête qui vient d'échouer.
    .catch(() => null)
  if (!answer) return

  if (answer.files.length > 0) {
    // Relu après l'attente, et non repris de l'instantané d'avant la requête : deux lots
    // peuvent être en vol pour la même conversation, puisque `flush` libère la file dès
    // son entrée. Repartir de l'instantané ferait perdre au second les fichiers que le
    // premier vient d'ajouter, définitivement : ils sont déjà marqués comme demandés.
    const current = resolutionOf(scope)
    // Un ensemble neuf, et non muté : `useSyncExternalStore` compare les identités, et
    // un ajout en place ne déclencherait aucun rendu.
    byScope.set(scope, {
      files: new Set([...current.files, ...answer.files]),
      asked: current.asked,
    })
    emit()
  }

  // Le lot était plafonné : ce qui n'est pas passé repart au tour suivant.
  const overflow = [...queued].slice(BATCH_LIMIT)
  if (overflow.length > 0) {
    request(scope, overflow)
  }
}

/** Met des chemins en file, et déclenche un lot si aucun n'attend déjà. */
function request(scope: WorkspaceScope, paths: string[]): void {
  const resolution = resolutionOf(scope)
  const fresh = paths.filter((path) => !resolution.asked.has(path))
  if (fresh.length === 0) return

  const queued = pending.get(scope)
  if (queued) {
    for (const path of fresh) queued.add(path)
    return
  }

  pending.set(scope, new Set(fresh))
  // Une micro-tâche suffit : tous les messages d'un même rendu déposent leurs candidats
  // avant qu'elle ne s'exécute.
  void Promise.resolve().then(() => flush(scope))
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Portée dont le workspace sert de référence aux chemins du fil : la conversation, ou
 * le projet pour l'aperçu d'un fichier ouvert depuis son panneau.
 *
 * Un contexte plutôt qu'une prop : `Markdown` est rendu depuis une dizaine d'endroits,
 * dont les notes de version et l'aperçu des réglages, où aucune conversation n'existe.
 * Ceux-là n'ont rien à passer et n'obtiennent pas de liens, ce qui est correct.
 */
export const FileLinkContext = createContext<WorkspaceScope | null>(null)

/**
 * Fichiers connus pour cette conversation, et soumission des candidats manquants.
 *
 * Renvoie un ensemble vide hors conversation : le rendu ne produit alors aucun lien.
 */
export function useKnownFiles(candidates: Set<string>): Set<string> {
  const scope = useContext(FileLinkContext)

  const files = useSyncExternalStore(
    subscribe,
    () => (scope ? byScope.get(scope)?.files : undefined) ?? EMPTY,
    () => EMPTY,
  )

  // `candidates` est un ensemble neuf à chaque analyse : la clé de dépendance est son
  // contenu, sinon l'effet repartirait à chaque rendu.
  const key = [...candidates].sort().join('\n')
  useEffect(() => {
    if (!scope || key.length === 0) return
    request(scope, key.split('\n'))
  }, [scope, key])

  return files
}
