import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import {
  foldForMatch,
  fuzzyTokens,
  matchFields,
  type ConversationDto,
  type FuzzyField,
  type PaletteCatalogDto,
  type PaletteFilesDto,
} from '@sillage/protocol'
import { api } from './api'
import { useDebounced } from './search'

/**
 * Palette de recherche : tout ce qu'on peut rejoindre, dans une seule liste classée et
 * groupée par projet.
 *
 * Ce module ne connaît que des résultats déjà décrits : le composant les fabrique à
 * partir des listes de l'interface, puis tout se classe ici de la même façon, qu'il
 * s'agisse d'une conversation, d'un fichier ou d'un réglage.
 */

export type PaletteKind =
  | 'project'
  | 'action'
  | 'conversation'
  | 'file'
  | 'card'
  | 'schedule'
  | 'skill'
  | 'mcp'
  | 'setting'
  | 'command'
  | 'message'

/**
 * Rang par nature : ce qui porte un nom passe avant les fichiers, et les fichiers avant
 * les passages de messages. Un dépôt a toujours un fichier qui ressemble à la saisie :
 * classés au score seul, ils couvraient le projet « Power Rush » quand on tapait « power ».
 */
const TIER: Record<PaletteKind, number> = {
  project: 0,
  action: 0,
  conversation: 0,
  card: 0,
  schedule: 0,
  skill: 0,
  mcp: 0,
  setting: 0,
  command: 0,
  file: 1,
  message: 2,
}

/** Départage des ex aequo : ce qu'on vise le plus souvent passe devant. */
const KIND_ORDER: Record<PaletteKind, number> = {
  project: 0,
  action: 1,
  conversation: 2,
  file: 3,
  card: 4,
  schedule: 5,
  skill: 6,
  mcp: 7,
  setting: 8,
  command: 9,
  message: 10,
}

export interface PaletteField extends FuzzyField {
  /**
   * Ce que le champ éclaire à l'affichage : le titre, la ligne de détail, ou rien quand
   * il ne sert qu'à restreindre, comme le nom du projet ou le type de résultat.
   */
  role: 'title' | 'detail' | 'context'
  /**
   * Contexte qui suffit seul à retenir le résultat : taper « skill » liste les skills,
   * taper le nom d'un projet liste ses conversations. Sans lui, un contexte ne fait que
   * restreindre : « nimbus » ne rend pas tous les fichiers de Nimbus.
   */
  browse?: boolean
  /** Champ qui doit porter au moins un mot pour que le résultat soit retenu. */
  required?: boolean
}

export type PaletteTarget =
  | { type: 'navigate'; to: string }
  | { type: 'file'; projectId: string; path: string }
  | { type: 'run'; run: () => void }

export interface PaletteItem {
  key: string
  kind: PaletteKind
  /** Null pour ce qui n'appartient à aucun projet : réglages, skills globaux, MCP. */
  projectId: string | null
  title: string
  detail?: string
  /** Passage trouvé dans un message, bornes de correspondance comprises. */
  excerpt?: string
  /** Repère de la ligne : l'agent d'une conversation, l'icône d'un fichier... */
  icon: ReactNode
  /** Indication de droite : le type du résultat, ou l'état d'une conversation. */
  aside?: string
  /**
   * Date du résultat : affichée en ancienneté après `aside`, elle départage aussi les ex
   * aequo, le plus récent devant.
   */
  at?: number
  fields: PaletteField[]
  target: PaletteTarget
  /** Ajouté au score : un favori remonte, un fil archivé ou un skill éteint descend. */
  boost?: number
  /** Résultat déjà retenu ailleurs, comme un message trouvé par le serveur. */
  fixedScore?: number
}

export interface PaletteHit {
  item: PaletteItem
  score: number
  /** Lettres à surligner, en indices du titre et du détail affichés. */
  title: number[]
  detail: number[]
}

export interface PaletteGroup {
  /** Identifiant du projet, ou `GENERAL_GROUP`. */
  key: string
  projectId: string | null
  hits: PaletteHit[]
  score: number
}

const GENERAL_GROUP = 'general'

/**
 * Prime du projet où l'on se trouve : à correspondance égale, c'est là qu'on cherche,
 * mais un meilleur résultat ailleurs doit passer devant.
 */
const CURRENT_PROJECT_BONUS = 1

/** Poids partagés par les fabricants de résultats. */
export const WEIGHT = {
  title: 1,
  dir: 0.6,
  detail: 0.4,
  context: 0.35,
} as const

/** Champ prêt à chercher, son repli calculé une fois plutôt qu'à chaque frappe. */
export function field(text: string, role: PaletteField['role'], weight: number, extra: Partial<PaletteField> = {}): PaletteField {
  return { text, role, weight, folded: foldForMatch(text), ...extra }
}

/** Le nom du projet, qui restreint sans rien surligner. */
export function projectField(name: string, extra: Pick<PaletteField, 'browse' | 'required'> = {}): PaletteField {
  return field(name, 'context', WEIGHT.context, { mode: 'strict', ...extra })
}

/** Le type de résultat : taper « ticket » ou « skill » liste ce type. */
export function kindField(label: string): PaletteField {
  return field(label, 'context', WEIGHT.context, { mode: 'strict', browse: true })
}

function hitOf(item: PaletteItem, tokens: readonly string[]): PaletteHit | null {
  if (item.fixedScore !== undefined) return { item, score: item.fixedScore, title: [], detail: [] }

  const match = matchFields(item.fields, tokens)
  if (!match) return null
  if (item.fields.some((entry, index) => entry.required && !match.matched[index])) return null
  const own = item.fields.some((entry, index) => match.matched[index] && entry.role !== 'context')
  const browsed = item.fields.some(
    (entry, index) => match.matched[index] && entry.role === 'context' && entry.browse,
  )
  if (!own && !browsed) return null

  const title = new Set<number>()
  const detail = new Set<number>()
  for (const [index, entry] of item.fields.entries()) {
    if (entry.role === 'context') continue
    const target = entry.role === 'title' ? title : detail
    for (const position of match.positions[index] ?? []) target.add(position)
  }

  return {
    item,
    score: match.score + (item.boost ?? 0),
    title: [...title].sort((a, b) => a - b),
    detail: [...detail].sort((a, b) => a - b),
  }
}

function compareHits(a: PaletteHit, b: PaletteHit): number {
  return (
    TIER[a.item.kind] - TIER[b.item.kind] ||
    b.score - a.score ||
    KIND_ORDER[a.item.kind] - KIND_ORDER[b.item.kind] ||
    (b.item.at ?? 0) - (a.item.at ?? 0) ||
    a.item.title.localeCompare(b.item.title)
  )
}

export interface RankContext {
  currentProjectId: string | null
  /** Ordre de la sidebar, qui départage deux groupes de même score. */
  projectOrder: readonly string[]
}

function groupRank(context: RankContext, group: PaletteGroup): number {
  if (group.projectId === null) return Number.MAX_SAFE_INTEGER
  const index = context.projectOrder.indexOf(group.projectId)
  return index === -1 ? Number.MAX_SAFE_INTEGER - 1 : index
}

/**
 * Classe tous les résultats contre la saisie, et les range par projet.
 *
 * Les groupes se suivent par leur meilleur résultat, pas dans l'ordre de la sidebar :
 * taper le nom d'un projet doit l'amener en tête, même depuis un autre projet.
 */
export function rankPalette(items: readonly PaletteItem[], query: string, context: RankContext): PaletteGroup[] {
  const tokens = fuzzyTokens(query)
  const groups = new Map<string, PaletteGroup>()

  for (const item of items) {
    const hit = hitOf(item, tokens)
    if (!hit) continue
    const key = item.projectId ?? GENERAL_GROUP
    let group = groups.get(key)
    if (!group) {
      group = { key, projectId: item.projectId, hits: [], score: 0 }
      groups.set(key, group)
    }
    group.hits.push(hit)
  }

  for (const group of groups.values()) {
    group.hits.sort(compareHits)
    const current = group.projectId !== null && group.projectId === context.currentProjectId
    group.score = (group.hits[0]?.score ?? 0) + (current ? CURRENT_PROJECT_BONUS : 0)
  }

  const tier = (group: PaletteGroup) => (group.hits[0] ? TIER[group.hits[0].item.kind] : 0)
  return [...groups.values()].sort(
    (a, b) => tier(a) - tier(b) || b.score - a.score || groupRank(context, a) - groupRank(context, b),
  )
}

/** Conversations proposées sans saisie, par projet. */
const RECENT_IN_CURRENT = 5
const RECENT_PER_PROJECT = 3
const RECENT_PROJECTS = 4

/**
 * Sans saisie, la palette sert de sélecteur rapide : les dernières conversations, le
 * projet courant d'abord, puis ceux où l'on a travaillé le plus récemment.
 *
 * La conversation ouverte n'y figure pas, y revenir ne mène nulle part ; les tirs
 * planifiés non plus, qui ne sont pas des sessions qu'on suit.
 */
export function recentPalette(
  conversations: readonly ConversationDto[],
  items: ReadonlyMap<string, PaletteItem>,
  { currentProjectId, currentConversationId, visibleProjects }: {
    currentProjectId: string | null
    currentConversationId: string | null
    visibleProjects: ReadonlySet<string>
  },
): PaletteGroup[] {
  const byProject = new Map<string, ConversationDto[]>()
  const recent = [...conversations]
    .filter(
      (entry) =>
        entry.id !== currentConversationId &&
        entry.archivedAt === null &&
        entry.scheduleId === null &&
        visibleProjects.has(entry.projectId),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt)
  for (const entry of recent) {
    const list = byProject.get(entry.projectId) ?? []
    list.push(entry)
    byProject.set(entry.projectId, list)
  }

  const order = [...byProject.keys()].sort((a, b) => {
    if (a === currentProjectId) return -1
    if (b === currentProjectId) return 1
    return 0
  })

  return order.slice(0, RECENT_PROJECTS).map((projectId) => {
    const limit = projectId === currentProjectId ? RECENT_IN_CURRENT : RECENT_PER_PROJECT
    const hits = (byProject.get(projectId) ?? [])
      .slice(0, limit)
      .map((entry) => items.get(`conversation:${entry.id}`))
      .filter((item) => item !== undefined)
      .map((item): PaletteHit => ({ item, score: 0, title: [], detail: [] }))
    return { key: projectId, projectId, hits, score: 0 }
  })
}

/**
 * Listes que la palette filtre elle-même : cartes et skills de tous les projets.
 *
 * Relues à chaque ouverture plutôt que tenues à jour : une carte renommée ou un skill
 * ajouté depuis la dernière recherche doit s'y trouver, et la liste est légère.
 */
export function usePaletteCatalog(enabled: boolean) {
  return useQuery({
    queryKey: ['palette', 'catalog'],
    queryFn: () => api.get<PaletteCatalogDto>('/api/palette/catalog'),
    enabled,
    staleTime: 0,
  })
}

/** En deçà, un nom de fichier ne discrimine rien et la marche coûte le plus cher. */
export const PALETTE_FILES_MIN_QUERY = 2

/**
 * Fichiers de tous les projets.
 *
 * `keepPreviousData` : la palette reclasse elle-même chaque fichier contre la saisie du
 * moment, donc une réponse d'une frappe en retard ne montre jamais un fichier qui ne
 * correspond plus ; elle évite seulement que la section se vide à chaque lettre.
 */
export function usePaletteFiles(query: string, conversationId: string | null) {
  const trimmed = query.trim()
  const settled = useDebounced(trimmed, 150)
  const result = useQuery({
    queryKey: ['palette', 'files', settled, conversationId],
    queryFn: () => {
      const params = new URLSearchParams({ q: settled })
      if (conversationId) params.set('conversationId', conversationId)
      return api.get<PaletteFilesDto>(`/api/palette/files?${params}`)
    },
    enabled: settled.length >= PALETTE_FILES_MIN_QUERY,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  })
  return {
    data: result.data,
    isFetching: result.isFetching,
    isError: result.isError,
    // Comme pour les messages : la saisie attend encore son délai de frappe.
    settling: settled !== trimmed && trimmed.length >= PALETTE_FILES_MIN_QUERY,
  }
}
