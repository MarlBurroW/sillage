import { useSyncExternalStore } from 'react'
import { MAX_UPLOAD_BYTES, MAX_UPLOAD_FILES } from '@sillage/protocol'
import { translate, translateError } from './i18n'
import { workspaceApiBase, type WorkspaceScope } from './workspace-scope'

/**
 * Fichiers déposés dans l'explorateur, en cours d'envoi vers le workspace.
 *
 * Hors de React, comme les onglets de l'éditeur : un envoi survit au repli de la
 * colonne et au passage d'un onglet du panneau à l'autre, alors qu'un état de composant
 * disparaîtrait avec lui — en laissant les requêtes tourner sans plus rien pour les
 * montrer.
 *
 * `XMLHttpRequest` et non `fetch` : c'est le seul moyen d'obtenir la progression de
 * l'envoi dans un navigateur. `fetch` ne rapporte que le téléchargement.
 */

export interface Upload {
  id: string
  scope: WorkspaceScope
  /** Destination, relative au répertoire de travail. */
  path: string
  /** Nom affiché : le chemin depuis le dossier visé, pour situer un fichier de sous-dossier. */
  label: string
  sizeBytes: number
  sentBytes: number
  status: 'pending' | 'sending' | 'done' | 'error'
  /** Message déjà traduit, présent seulement en `error`. */
  error: string | null
}

/** Fichier retenu d'un dépôt, avec sa place dans l'arborescence lâchée. */
export interface DroppedFile {
  file: File
  /** Chemin relatif au dossier visé : un nom simple, ou `dossier/sous/fichier`. */
  relativePath: string
}

/**
 * Envois menés de front.
 *
 * Trois plutôt qu'un : un dossier de petits fichiers passe son temps en aller-retours
 * plutôt qu'en transfert. Plutôt que tous à la fois : la barre de progression d'une
 * centaine d'envois qui avancent d'un pour cent chacun ne dit plus rien, et le serveur
 * écrit alors cent fichiers partiels en parallèle.
 */
const CONCURRENCY = 3

/** Délai avant qu'un envoi réussi quitte la liste. Assez pour être vu, pas pour gêner. */
const KEEP_DONE_MS = 2500

let uploads: Upload[] = []
/** Snapshots par portée, reconstruits à chaque émission : `useSyncExternalStore` exige
 *  qu'une lecture sans changement rende exactement le même objet. */
let byScope = new Map<WorkspaceScope, Upload[]>()
const EMPTY: Upload[] = []

const listeners = new Set<() => void>()
/** Requêtes en vol, pour pouvoir annuler un envoi qu'on regrette. */
const inFlight = new Map<string, XMLHttpRequest>()
/** Rafraîchissement de l'arborescence, posé par la portée affichée. */
const refreshers = new Map<WorkspaceScope, Set<() => void>>()

function emit(): void {
  const next = new Map<WorkspaceScope, Upload[]>()
  for (const upload of uploads) {
    const list = next.get(upload.scope)
    if (list) list.push(upload)
    else next.set(upload.scope, [upload])
  }
  byScope = next
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useUploads(scope: WorkspaceScope): Upload[] {
  return useSyncExternalStore(
    subscribe,
    () => byScope.get(scope) ?? EMPTY,
    () => EMPTY,
  )
}

/**
 * Déclare de quoi relire l'arborescence d'une portée après un envoi.
 *
 * La veille disque du serveur signale déjà les fichiers arrivés, mais elle ne couvre
 * que les niveaux dépliés : déposer dans un dossier replié n'y ferait rien apparaître à
 * son ouverture, la liste venant du cache. Le rafraîchissement explicite ferme ce trou.
 */
export function registerTreeRefresh(scope: WorkspaceScope, refresh: () => void): () => void {
  const set = refreshers.get(scope) ?? new Set()
  set.add(refresh)
  refreshers.set(scope, set)
  return () => {
    set.delete(refresh)
    if (set.size === 0) refreshers.delete(scope)
  }
}

function patch(id: string, changes: Partial<Upload>): void {
  uploads = uploads.map((upload) => (upload.id === id ? { ...upload, ...changes } : upload))
  emit()
}

export function dismissUpload(id: string): void {
  inFlight.get(id)?.abort()
  inFlight.delete(id)
  uploads = uploads.filter((upload) => upload.id !== id)
  emit()
}

/** Retire les envois terminés d'une portée, réussis comme échoués. */
export function clearSettledUploads(scope: WorkspaceScope): void {
  uploads = uploads.filter(
    (upload) => upload.scope !== scope || (upload.status !== 'done' && upload.status !== 'error'),
  )
  emit()
}

/** File d'attente et nombre d'envois en cours, partagés par toutes les portées. */
const pending: { upload: Upload; file: File }[] = []
let running = 0

/**
 * Met en file les fichiers d'un dépôt, à destination de `parent`.
 *
 * Le refus pour cause de nombre est signalé comme un envoi en erreur plutôt que jeté :
 * l'appelant l'afficherait dans un endroit de plus, alors que la liste des envois est
 * déjà sous les yeux.
 */
export function enqueueUploads(
  scope: WorkspaceScope,
  parent: string,
  files: DroppedFile[],
): void {
  if (files.length === 0) return

  if (files.length > MAX_UPLOAD_FILES) {
    uploads = [
      ...uploads,
      {
        id: crypto.randomUUID(),
        scope,
        path: parent,
        label: files[0]?.relativePath.split('/')[0] ?? '',
        sizeBytes: 0,
        sentBytes: 0,
        status: 'error',
        error: translate('uploads.tooMany', { count: files.length, max: MAX_UPLOAD_FILES }),
      },
    ]
    emit()
    return
  }

  const queued: Upload[] = files.map(({ file, relativePath }) => {
    const tooLarge = file.size > MAX_UPLOAD_BYTES
    return {
      id: crypto.randomUUID(),
      scope,
      path: parent ? `${parent}/${relativePath}` : relativePath,
      label: relativePath,
      sizeBytes: file.size,
      sentBytes: 0,
      // Refusé avant d'être envoyé : inutile de faire monter cent mégaoctets pour
      // s'entendre répondre non au bout.
      status: tooLarge ? 'error' : 'pending',
      error: tooLarge
        ? translate('uploads.tooLarge', {
            name: relativePath,
            max: Math.round(MAX_UPLOAD_BYTES / 1024 / 1024),
          })
        : null,
    }
  })

  const sources = new Map(queued.map((upload, index) => [upload.id, files[index]?.file as File]))
  uploads = [...uploads, ...queued]
  emit()

  for (const upload of queued) {
    if (upload.status === 'pending') pending.push({ upload, file: sources.get(upload.id) as File })
  }
  pump()
}

function pump(): void {
  while (running < CONCURRENCY && pending.length > 0) {
    const next = pending.shift()
    if (!next) return
    // L'entrée a pu être retirée entre la mise en file et son tour.
    if (!uploads.some((upload) => upload.id === next.upload.id)) continue

    running += 1
    void send(next.upload, next.file).finally(() => {
      running -= 1
      pump()
    })
  }
}

async function send(upload: Upload, file: File): Promise<void> {
  patch(upload.id, { status: 'sending' })

  try {
    await put(upload, file)
    patch(upload.id, { status: 'done', sentBytes: upload.sizeBytes })
    for (const refresh of refreshers.get(upload.scope) ?? []) refresh()
    // Un envoi réussi n'a plus rien à dire une fois l'arborescence à jour : il s'efface,
    // là où une erreur reste jusqu'à ce qu'elle soit lue.
    setTimeout(() => {
      if (uploads.some((entry) => entry.id === upload.id && entry.status === 'done')) {
        dismissUpload(upload.id)
      }
    }, KEEP_DONE_MS)
  } catch (err) {
    // Une annulation retire déjà l'entrée : il n'y a plus rien à marquer en erreur.
    if (!uploads.some((entry) => entry.id === upload.id)) return
    patch(upload.id, {
      status: 'error',
      error: err instanceof Error ? err.message : translate('uploads.failed'),
    })
  } finally {
    inFlight.delete(upload.id)
  }
}

function put(upload: Upload, file: File): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    inFlight.set(upload.id, request)

    const url = `${workspaceApiBase(upload.scope)}/entries/upload?path=${encodeURIComponent(upload.path)}`
    request.open('POST', url)

    // Le navigateur compose lui-même l'en-tête `content-type` du multipart, frontière
    // comprise : le poser à la main casserait le découpage.
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) patch(upload.id, { sentBytes: event.loaded })
    })

    request.addEventListener('load', () => {
      if (request.status >= 200 && request.status < 300) {
        resolve()
        return
      }
      reject(errorOf(request))
    })
    request.addEventListener('error', () => reject(new Error(translate('uploads.failed'))))
    request.addEventListener('abort', () => reject(new Error(translate('uploads.cancelled'))))

    const body = new FormData()
    body.append('file', file, file.name)
    request.send(body)
  })
}

/** Le corps d'erreur de l'API, traduit comme partout ailleurs, ou le statut à défaut. */
function errorOf(request: XMLHttpRequest): Error {
  try {
    const payload = JSON.parse(request.responseText) as {
      error?: { code: string; message: string; params?: Record<string, string | number> }
    }
    const error = payload.error
    if (error) return new Error(translateError(error.code, error.message, error.params))
  } catch {
    // Réponse illisible (proxy, coupure) : le statut est tout ce qu'on peut en dire.
  }
  return new Error(translate('error.http', { status: request.status }))
}

/**
 * Fichiers portés par un dépôt, dossiers dépliés.
 *
 * `webkitGetAsEntry` est la seule voie pour lire un dossier lâché : `dataTransfer.files`
 * n'en montre que l'entrée elle-même, sans contenu et sans taille, ce qui produisait un
 * envoi vide. Le nom n'est pas normalisé mais il est de fait universel.
 *
 * Les entrées sont saisies d'abord, avant toute attente : la liste d'un `DataTransfer`
 * est vidée dès que le gestionnaire d'événement rend la main.
 */
export async function filesFromDrop(transfer: DataTransfer): Promise<DroppedFile[]> {
  const entries = Array.from(transfer.items)
    .filter((item) => item.kind === 'file')
    .map((item) => item.webkitGetAsEntry())
    .filter((entry): entry is FileSystemEntry => entry !== null)

  if (entries.length === 0) {
    // Navigateur sans l'API, ou dépôt qui ne la déclenche pas : les fichiers nus font
    // l'affaire, et un dossier n'y figure de toute façon pas.
    return Array.from(transfer.files).map((file) => ({ file, relativePath: file.name }))
  }

  const collected: DroppedFile[] = []
  for (const entry of entries) await collect(entry, '', collected)
  return collected
}

async function collect(entry: FileSystemEntry, prefix: string, into: DroppedFile[]): Promise<void> {
  // Au-delà du plafond, la suite ne servirait qu'à être refusée : la marche s'arrête,
  // et l'appelant voit un dépôt trop gros plutôt qu'un dépôt tronqué.
  if (into.length > MAX_UPLOAD_FILES) return

  const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name

  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) => {
      ;(entry as FileSystemFileEntry).file(resolve, () => resolve(null))
    })
    // Un fichier illisible (déplacé entre le dépôt et la lecture) est passé plutôt que
    // de faire échouer tout le lot.
    if (file) into.push({ file, relativePath })
    return
  }

  if (!entry.isDirectory) return

  const reader = (entry as FileSystemDirectoryEntry).createReader()
  // `readEntries` ne rend qu'un lot à la fois, une centaine d'entrées : il faut le
  // rappeler jusqu'au lot vide, sans quoi un gros dossier arrive amputé.
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve) => {
      reader.readEntries(resolve, () => resolve([]))
    })
    if (batch.length === 0) return
    for (const child of batch) await collect(child, relativePath, into)
  }
}

/** Vrai si un glissement porte des fichiers venus du système, et non une entrée déplacée. */
export function carriesExternalFiles(transfer: DataTransfer): boolean {
  return Array.from(transfer.types).includes('Files')
}
