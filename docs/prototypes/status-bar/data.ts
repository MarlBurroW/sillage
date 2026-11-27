import type { AgentKind } from '@sillage/protocol'

// Fictional data for the status bar study. Which CLI reports what comes from reading the adapters
// (apps/server/src/agents), not from probing the binaries: confirm before implementing.

export type Scenario = 'idle' | 'running' | 'limit'
export type Format = 'bar' | 'ring' | 'text'
export type QuotaOption = 'busiest' | 'all'

export type ItemKey =
  | 'cli' | 'quota' | 'context' | 'tokens' | 'lastTurn' | 'cost' | 'agents' | 'clock'
  | 'workTime' | 'model' | 'version' | 'worktree' | 'files' | 'tools' | 'previews' | 'shortcuts'

export interface Entry {
  key: ItemKey
  on: boolean
  format?: Format
  option?: QuotaOption
}

export interface ItemSpec {
  key: ItemKey
  name: string
  description: string
  /** Null: every CLI. */
  support: AgentKind[] | null
  formats?: Format[]
  /** Study note: data the client does not have yet. */
  toBuild?: boolean
}

export const AGENTS: AgentKind[] = ['claude', 'codex', 'copilot', 'opencode', 'grok', 'antigravity']

export const CATALOG: ItemSpec[] = [
  { key: 'cli', name: 'CLI et état', description: 'Logo du CLI, session chaude ou au repos', support: null },
  { key: 'quota', name: 'Quota du compte', description: 'Fenêtres d’usage remontées par le CLI', support: ['claude', 'codex', 'copilot', 'grok', 'antigravity'], formats: ['bar', 'ring', 'text'] },
  { key: 'context', name: 'Contexte', description: 'Remplissage de la fenêtre de contexte ; remplace la jauge du composer', support: null, formats: ['ring', 'bar', 'text'] },
  { key: 'tokens', name: 'Tokens de la session', description: 'Entrée, sortie et cache, détail au survol', support: null },
  { key: 'lastTurn', name: 'Tokens du dernier tour', description: 'Ce qu’a coûté le dernier message', support: null, toBuild: true },
  { key: 'cost', name: 'Coût équivalent API', description: 'Non facturé sur un abonnement', support: ['claude'] },
  { key: 'agents', name: 'Sous-agents et tâches de fond', description: 'Masqué quand rien ne tourne', support: ['claude', 'codex', 'opencode'] },
  { key: 'clock', name: 'Durée du tour', description: 'Pendant qu’un tour tourne', support: null },
  { key: 'workTime', name: 'Temps de travail', description: 'Temps passé par l’agent dans cette session', support: null, toBuild: true },
  { key: 'model', name: 'Modèle réel', description: 'Le modèle résolu, pas l’alias', support: null },
  { key: 'version', name: 'Version du CLI', description: 'Celle du process qui tient la session', support: ['claude'] },
  { key: 'worktree', name: 'Worktree', description: 'Branche, état et pull request', support: null },
  { key: 'files', name: 'Fichiers modifiés', description: 'Par cette session', support: null },
  { key: 'tools', name: 'Appels d’outils', description: 'Avec les erreurs', support: null },
  { key: 'previews', name: 'Aperçus actifs', description: 'Serveurs de dev lancés par la session', support: null },
  { key: 'shortcuts', name: 'Rappel des raccourcis', description: 'À droite, sur ordinateur seulement', support: null },
]

export const SPEC = Object.fromEntries(CATALOG.map((spec) => [spec.key, spec])) as Record<ItemKey, ItemSpec>

/** Every catalog item, in catalog order, with the given ones switched on first. */
function preset(on: Omit<Entry, 'on'>[]): Entry[] {
  const chosen = new Set(on.map((entry) => entry.key))
  return [
    ...on.map((entry) => ({ ...entry, on: true })),
    ...CATALOG.filter((spec) => !chosen.has(spec.key)).map((spec) => ({ key: spec.key, on: false, format: spec.formats?.[0] })),
  ]
}

export const PRESETS: Record<'default' | 'rich' | 'minimal', { label: string; entries: Entry[] }> = {
  default: {
    label: 'Défaut',
    entries: preset([
      { key: 'cli' },
      { key: 'quota', format: 'bar', option: 'busiest' },
      { key: 'tokens' },
      { key: 'agents' },
      { key: 'shortcuts' },
    ]),
  },
  rich: {
    label: 'Chargée',
    entries: preset([
      { key: 'cli' },
      { key: 'quota', format: 'bar', option: 'all' },
      { key: 'context', format: 'ring' },
      { key: 'lastTurn' },
      { key: 'tokens' },
      { key: 'cost' },
      { key: 'agents' },
      { key: 'clock' },
      { key: 'worktree' },
      { key: 'files' },
      { key: 'model' },
      { key: 'version' },
    ]),
  },
  minimal: {
    label: 'Minimale',
    entries: preset([
      { key: 'cli' },
      { key: 'quota', format: 'ring', option: 'busiest' },
    ]),
  },
}

export interface Window {
  label: string
  /** Long name for tooltips and the sheet. */
  title: string
  utilization: number
  /** Minutes until reset; null when the CLI gives none. */
  resetIn: number | null
}

export interface AgentData {
  model: string
  chip: string
  windows: Window[]
  tokens: { input: number; output: number; cacheWrite: number; cacheRead: number }
  lastTurn: number
  cost: number
  context: { used: number; max: number }
  version: string
}

const HOUR = 60
const DAY = 24 * HOUR

export const AGENT_DATA: Record<AgentKind, AgentData> = {
  claude: {
    model: 'claude-opus-5-5',
    chip: 'Défaut : Opus 5.5',
    windows: [
      { label: '5 h', title: 'Fenêtre de 5 heures', utilization: 0.42, resetIn: 80 },
      { label: '7 j', title: 'Fenêtre de 7 jours', utilization: 0.18, resetIn: 3 * DAY + 4 * HOUR },
      { label: '7 j Opus', title: 'Fenêtre Opus de 7 jours', utilization: 0.31, resetIn: 3 * DAY + 4 * HOUR },
    ],
    tokens: { input: 18_400, output: 41_200, cacheWrite: 96_000, cacheRead: 1_062_000 },
    lastTurn: 85_300,
    cost: 4.12,
    context: { used: 58_000, max: 200_000 },
    version: '2.1.332',
  },
  codex: {
    model: 'gpt-5.5-codex',
    chip: 'gpt-5.5-codex',
    windows: [
      { label: '5 h', title: 'Fenêtre de 5 heures', utilization: 0.27, resetIn: 3 * HOUR + 10 },
      { label: 'Hebdo', title: 'Fenêtre hebdomadaire', utilization: 0.55, resetIn: 4 * DAY },
    ],
    tokens: { input: 210_000, output: 22_800, cacheWrite: 0, cacheRead: 640_000 },
    lastTurn: 61_000,
    cost: 0,
    context: { used: 91_000, max: 272_000 },
    version: '0.172.0',
  },
  copilot: {
    model: 'claude-sonnet-5.5',
    chip: 'Claude Sonnet 5.5',
    windows: [
      { label: 'Premium', title: 'Requêtes premium du mois', utilization: 0.64, resetIn: 12 * DAY },
    ],
    tokens: { input: 74_000, output: 9_100, cacheWrite: 0, cacheRead: 120_000 },
    lastTurn: 23_000,
    cost: 0,
    context: { used: 44_000, max: 128_000 },
    version: '1.0.4',
  },
  opencode: {
    model: 'anthropic/claude-sonnet-5-5',
    chip: 'claude-sonnet-5-5',
    windows: [],
    tokens: { input: 52_000, output: 12_400, cacheWrite: 30_000, cacheRead: 410_000 },
    lastTurn: 38_000,
    cost: 0,
    context: { used: 67_000, max: 200_000 },
    version: '2.4.1',
  },
  grok: {
    model: 'grok-build-1',
    chip: 'Grok Build',
    windows: [
      { label: 'Hebdo', title: 'Crédits de la semaine', utilization: 0.12, resetIn: 5 * DAY },
      { label: 'Mois', title: 'Crédits du mois', utilization: 0.08, resetIn: 19 * DAY },
    ],
    tokens: { input: 33_000, output: 6_200, cacheWrite: 0, cacheRead: 88_000 },
    lastTurn: 17_500,
    cost: 0,
    context: { used: 39_000, max: 256_000 },
    version: '0.9.2',
  },
  antigravity: {
    model: 'gemini-3-pro',
    chip: 'Gemini 3 Pro',
    windows: [
      { label: 'Gemini Pro', title: 'Quota Gemini Pro (sans heure de reset)', utilization: 0.4, resetIn: null },
      { label: 'Claude', title: 'Quota Claude (sans heure de reset)', utilization: 0.1, resetIn: null },
    ],
    tokens: { input: 61_000, output: 8_800, cacheWrite: 0, cacheRead: 150_000 },
    lastTurn: 29_000,
    cost: 0,
    context: { used: 120_000, max: 1_000_000 },
    version: '1.4.1',
  },
}

/** Scenario overrides: the limit case pushes the quota windows near their end. */
export function windowsFor(agent: AgentKind, scenario: Scenario): Window[] {
  const windows = AGENT_DATA[agent].windows
  if (scenario !== 'limit') return windows
  return windows.map((window, index) => ({ ...window, utilization: index === 0 ? 0.93 : Math.min(0.81, window.utilization + 0.4) }))
}

export const SUBAGENTS = [
  { name: 'Explore', activity: 'lit apps/web/src/components/chat' },
  { name: 'Explore', activity: 'cherche les usages de busiestWindows' },
  { name: 'Plan', activity: 'rédige le plan d’implémentation' },
]

export function formatTokens(count: number): string {
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${Math.round(count / 1000)} k`
  return `${(count / 1_000_000).toFixed(1).replace('.', ',')} M`
}

export function formatReset(minutes: number | null): string | null {
  if (minutes === null) return null
  if (minutes < 60) return `${minutes} min`
  if (minutes < 48 * 60) {
    const hours = Math.floor(minutes / 60)
    const rest = minutes % 60
    return rest ? `${hours} h ${String(rest).padStart(2, '0')}` : `${hours} h`
  }
  return `${Math.round(minutes / 1440)} j`
}

/** Same thresholds as the usage panel (UsageBar) and the context gauge. */
export function toneOf(ratio: number): 'accent' | 'caution' | 'critical' {
  if (ratio >= 0.9) return 'critical'
  if (ratio >= 0.75) return 'caution'
  return 'accent'
}
