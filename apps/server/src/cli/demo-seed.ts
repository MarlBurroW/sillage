import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SillageEvent } from '@sillage/protocol'
import {
  openDatabase,
  users,
  projects,
  worktrees,
  cards,
  cardNotes,
  cardRefs,
  conversations,
  conversationReads,
  events,
  permissionRequests,
  mcpServers,
} from '@sillage/db'
import { hashPassword } from '../auth/passwords.js'
import { loadConfig } from '../config.js'
import { migrationsFolder, runPendingMigrations } from '../migrations.js'

/**
 * Peuple une instance dédiée aux captures d'écran du site : un compte, deux projets,
 * des conversations aux journaux rejouables et un board de cartes, le tout en anglais.
 *
 * À lancer sur un SILLAGE_DATA_DIR qui n'est PAS celui de la production : le script
 * vide les tables avant d'écrire. Il peut tourner avant ou après le démarrage du
 * serveur ; après, les statuts « running » et « awaiting_input » survivent jusqu'au
 * prochain redémarrage, ce qui est exactement la fenêtre des captures.
 */

const DEMO_USERNAME = 'alex'
const DEMO_PASSWORD = 'sillage-demo'

const CLAUDE_TOOLS = [
  'Task',
  'AskUserQuestion',
  'Bash',
  'Edit',
  'ExitPlanMode',
  'Glob',
  'Grep',
  'NotebookEdit',
  'Read',
  'TodoWrite',
  'WebFetch',
  'WebSearch',
  'Write',
]

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Alex Demo',
      GIT_AUTHOR_EMAIL: 'alex@example.com',
      GIT_COMMITTER_NAME: 'Alex Demo',
      GIT_COMMITTER_EMAIL: 'alex@example.com',
    },
  })
}

function writeTree(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, content)
  }
}

/** Le dépôt Nimbus : une PWA météo, assez de fichiers pour que l'explorateur vive. */
function createNimbusRepo(root: string): void {
  if (existsSync(root)) return
  mkdirSync(root, { recursive: true })
  writeTree(root, {
    'package.json': `${JSON.stringify(
      {
        name: 'nimbus',
        private: true,
        version: '0.9.0',
        type: 'module',
        scripts: { dev: 'vite', build: 'tsc -b && vite build', test: 'vitest run' },
        dependencies: { react: '^19.1.0', 'react-dom': '^19.1.0' },
        devDependencies: {
          typescript: '~5.8.3',
          vite: '^6.3.5',
          vitest: '^3.1.4',
          '@vitejs/plugin-react': '^4.4.1',
        },
      },
      null,
      2,
    )}\n`,
    'README.md': `# Nimbus

A small offline-first weather PWA. Forecasts come from the Open-Meteo API and are
rendered per saved city.

## Development

\`\`\`sh
pnpm install
pnpm dev
\`\`\`
`,
    'index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Nimbus</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
    'vite.config.ts': `import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
})
`,
    'tsconfig.json': `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2022',
          module: 'ESNext',
          moduleResolution: 'bundler',
          jsx: 'react-jsx',
          strict: true,
          skipLibCheck: true,
        },
        include: ['src'],
      },
      null,
      2,
    )}\n`,
    'src/main.tsx': `import { createRoot } from 'react-dom/client'
import { App } from './App'

createRoot(document.getElementById('root')!).render(<App />)
`,
    'src/App.tsx': `import { CityList } from './components/CityList'

export function App() {
  return (
    <main className="app">
      <h1>Nimbus</h1>
      <CityList />
    </main>
  )
}
`,
    'src/components/CityList.tsx': `import { useEffect, useState } from 'react'
import { fetchForecast, type Forecast } from '../lib/forecast'
import { ForecastCard } from './ForecastCard'

const SAVED_CITIES = ['Lyon', 'Reykjavik', 'Osaka']

export function CityList() {
  const [forecasts, setForecasts] = useState<Forecast[]>([])

  useEffect(() => {
    Promise.all(SAVED_CITIES.map(fetchForecast)).then(setForecasts)
  }, [])

  return (
    <section className="cities">
      {forecasts.map((forecast) => (
        <ForecastCard key={forecast.city} forecast={forecast} />
      ))}
    </section>
  )
}
`,
    'src/components/ForecastCard.tsx': `import type { Forecast } from '../lib/forecast'

export function ForecastCard({ forecast }: { forecast: Forecast }) {
  return (
    <article className="forecast-card">
      <h2>{forecast.city}</h2>
      <p className="temperature">{Math.round(forecast.temperatureC)}°</p>
      <p className="summary">{forecast.summary}</p>
    </article>
  )
}
`,
    'src/lib/forecast.ts': `export interface Forecast {
  city: string
  temperatureC: number
  summary: string
  fetchedAt: number
}

const API_BASE = 'https://api.open-meteo.com/v1'

export async function fetchForecast(city: string): Promise<Forecast> {
  const response = await fetch(\`\${API_BASE}/forecast?city=\${encodeURIComponent(city)}\`)
  if (!response.ok) throw new Error(\`Forecast request failed: \${response.status}\`)
  const data = await response.json()
  return {
    city,
    temperatureC: data.current.temperature_2m,
    summary: data.current.summary,
    fetchedAt: Date.now(),
  }
}
`,
  })
  git(root, 'init', '-b', 'main')
  git(root, 'add', '-A')
  git(root, 'commit', '-m', 'Bootstrap Nimbus weather app')
}

/** L'autre projet de la sidebar : un service backend, deux commits suffisent. */
function createAtlasRepo(root: string): void {
  if (existsSync(root)) return
  mkdirSync(root, { recursive: true })
  writeTree(root, {
    'package.json': `${JSON.stringify(
      {
        name: 'atlas-api',
        private: true,
        version: '1.4.2',
        type: 'module',
        scripts: { dev: 'tsx watch src/main.ts', test: 'vitest run' },
        dependencies: { fastify: '^5.3.2' },
        devDependencies: { typescript: '~5.8.3', tsx: '^4.19.4', vitest: '^3.1.4' },
      },
      null,
      2,
    )}\n`,
    'README.md': '# Atlas API\n\nGeocoding and place search service behind Nimbus.\n',
    'src/main.ts': `import Fastify from 'fastify'
import { placesRoutes } from './routes/places'

const app = Fastify({ logger: true })
app.register(placesRoutes)

app.listen({ port: 3000, host: '0.0.0.0' })
`,
    'src/routes/places.ts': `import type { FastifyInstance } from 'fastify'
import { searchPlaces } from '../lib/search'

export async function placesRoutes(app: FastifyInstance) {
  app.get('/places', async (request) => {
    const { q } = request.query as { q?: string }
    return searchPlaces(q ?? '')
  })
}
`,
    'src/lib/search.ts': `export interface Place {
  name: string
  country: string
  latitude: number
  longitude: number
}

export async function searchPlaces(query: string): Promise<Place[]> {
  if (query.length < 2) return []
  // Backed by the geonames dump loaded at boot; trimmed here for brevity.
  return []
}
`,
  })
  git(root, 'init', '-b', 'main')
  git(root, 'add', '-A')
  git(root, 'commit', '-m', 'Bootstrap Atlas API')
}

/** Le site de documentation, troisième projet de la sidebar. */
function createDocsRepo(root: string): void {
  if (existsSync(root)) return
  mkdirSync(root, { recursive: true })
  writeTree(root, {
    'package.json': `${JSON.stringify(
      {
        name: 'nimbus-docs',
        private: true,
        version: '0.3.0',
        type: 'module',
        scripts: { dev: 'astro dev', build: 'astro build' },
        dependencies: { astro: '^5.7.0' },
      },
      null,
      2,
    )}\n`,
    'README.md': '# Nimbus docs\n\nUser guide and API reference, built with Astro.\n',
    'astro.config.mjs': `import { defineConfig } from 'astro/config'

export default defineConfig({
  site: 'https://docs.nimbus.example',
})
`,
    'src/pages/index.md': `---
title: Nimbus
---

Nimbus is a small offline-first weather PWA. Start with the quickstart, then the
city configuration guide.
`,
    'src/pages/quickstart.md': `---
title: Quickstart
---

## Install

\`\`\`sh
pnpm install
pnpm dev
\`\`\`

Open http://localhost:4321 and add your first city.
`,
  })
  git(root, 'init', '-b', 'main')
  git(root, 'add', '-A')
  git(root, 'commit', '-m', 'Bootstrap the docs site')
}

/**
 * Une branche de plus dans un vrai worktree : celle de la carte « à vérifier », avec
 * un commit non mergé pour que le board affiche un état de merge parlant.
 */
function createRadarWorktree(repoRoot: string, worktreePath: string): void {
  if (existsSync(worktreePath)) return
  mkdirSync(join(worktreePath, '..'), { recursive: true })
  git(repoRoot, 'worktree', 'add', '-b', 'feat/radar-prefetch', worktreePath, 'main')
  writeTree(worktreePath, {
    'src/lib/radar-prefetch.ts': `const PREFETCH_RING = 1

/** Prefetch the tiles around the viewport so panning never shows a blank. */
export function tilesToPrefetch(center: { x: number; y: number }, zoom: number) {
  const tiles: Array<{ x: number; y: number; z: number }> = []
  for (let dx = -PREFETCH_RING; dx <= PREFETCH_RING; dx++) {
    for (let dy = -PREFETCH_RING; dy <= PREFETCH_RING; dy++) {
      tiles.push({ x: center.x + dx, y: center.y + dy, z: zoom })
    }
  }
  return tiles
}
`,
  })
  git(worktreePath, 'add', '-A')
  git(worktreePath, 'commit', '-m', 'Prefetch radar tiles around the viewport')
}

/**
 * La branche du chantier « offline cache », dans un vrai worktree git : le board en
 * dérive l'état de merge, donc la branche doit exister et porter un commit non mergé.
 */
function createOfflineCacheWorktree(repoRoot: string, worktreePath: string): void {
  if (existsSync(worktreePath)) return
  mkdirSync(join(worktreePath, '..'), { recursive: true })
  git(repoRoot, 'worktree', 'add', '-b', 'feat/offline-cache', worktreePath, 'main')
  writeTree(worktreePath, {
    'src/lib/forecast-cache.ts': `import type { Forecast } from './forecast'

const STORE = 'nimbus.forecasts'

export function rememberForecast(forecast: Forecast): void {
  const cached = readAll()
  cached[forecast.city] = forecast
  localStorage.setItem(STORE, JSON.stringify(cached))
}

export function lastKnownForecast(city: string): Forecast | null {
  return readAll()[city] ?? null
}

function readAll(): Record<string, Forecast> {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? '{}')
  } catch {
    return {}
  }
}
`,
  })
  git(worktreePath, 'add', '-A')
  git(worktreePath, 'commit', '-m', 'Cache the last forecast per city')
  // Le reste du chantier reste non commité : la vue git du panneau montre ainsi un
  // vrai diff de travail, cohérent avec ce que la conversation du hero raconte.
  writeTree(worktreePath, {
    'src/lib/forecast.ts': `import { lastKnownForecast } from './forecast-cache'

export interface Forecast {
  city: string
  temperatureC: number
  summary: string
  fetchedAt: number
  fromCache?: boolean
}

const API_BASE = 'https://api.open-meteo.com/v1'

export async function fetchForecast(city: string): Promise<Forecast> {
  let response: Response
  try {
    response = await fetch(\`\${API_BASE}/forecast?city=\${encodeURIComponent(city)}\`)
  } catch (error) {
    const cached = lastKnownForecast(city)
    if (cached) return { ...cached, fromCache: true }
    throw error
  }
  if (!response.ok) throw new Error(\`Forecast request failed: \${response.status}\`)
  const data = await response.json()
  return {
    city,
    temperatureC: data.current.temperature_2m,
    summary: data.current.summary,
    fetchedAt: Date.now(),
  }
}
`,
    'src/components/ForecastCard.tsx': `import type { Forecast } from '../lib/forecast'

function age(fetchedAt: number): string {
  const minutes = Math.round((Date.now() - fetchedAt) / 60000)
  return minutes < 1 ? 'just now' : \`\${minutes} min ago\`
}

export function ForecastCard({ forecast, showAge }: { forecast: Forecast; showAge?: boolean }) {
  return (
    <article className="forecast-card">
      <h2>{forecast.city}</h2>
      <p className="temperature">{Math.round(forecast.temperatureC)}°</p>
      <p className="summary">{forecast.summary}</p>
      {forecast.fromCache && showAge ? (
        <p className="cached-badge">cached · {age(forecast.fetchedAt)}</p>
      ) : null}
    </article>
  )
}
`,
  })
}

interface SeededEvent {
  /** Décalage en secondes par rapport au début de la conversation. */
  at: number
  event: SillageEvent
}

async function main(): Promise<void> {
  const config = loadConfig()
  const dataDir = config.paths.data
  if (dataDir === join(process.env.HOME ?? '', '.local/share/sillage')) {
    throw new Error(
      'Refusing to seed the default data dir. Point SILLAGE_DATA_DIR at a demo dir.',
    )
  }

  const demoRoot = join(dataDir, 'demo')
  const nimbusRoot = join(demoRoot, 'nimbus')
  const atlasRoot = join(demoRoot, 'atlas-api')
  const docsRoot = join(demoRoot, 'nimbus-docs')
  const offlineCachePath = join(dataDir, 'worktrees', 'nimbus', 'feat-offline-cache')
  const radarPath = join(dataDir, 'worktrees', 'nimbus', 'feat-radar-prefetch')
  createNimbusRepo(nimbusRoot)
  createAtlasRepo(atlasRoot)
  createDocsRepo(docsRoot)
  createOfflineCacheWorktree(nimbusRoot, offlineCachePath)
  createRadarWorktree(nimbusRoot, radarPath)

  const { db, sqlite } = openDatabase(config.paths.database)
  runPendingMigrations(db, migrationsFolder())

  // Idempotent : on repart de zéro à chaque exécution, l'instance est jetable.
  await db.delete(events)
  await db.delete(permissionRequests)
  await db.delete(conversationReads)
  await db.delete(cardNotes)
  await db.delete(cardRefs)
  await db.delete(conversations)
  await db.delete(cards)
  await db.delete(worktrees)
  await db.delete(mcpServers)
  await db.delete(projects)
  await db.delete(users)

  const now = Date.now()
  const userId = randomUUID()
  await db.insert(users).values({
    id: userId,
    username: DEMO_USERNAME,
    passwordHash: await hashPassword(DEMO_PASSWORD),
    displayName: 'Alex',
    isAdmin: true,
    createdAt: now - 45 * 86400e3,
  })

  const nimbusId = randomUUID()
  const atlasId = randomUUID()
  const docsId = randomUUID()
  await db.insert(projects).values([
    {
      id: nimbusId,
      name: 'Nimbus',
      workspacePath: nimbusRoot,
      ownerId: userId,
      visibility: 'private',
      color: '#38bdf8',
      position: 0,
      createdAt: now - 40 * 86400e3,
    },
    {
      id: atlasId,
      name: 'Atlas API',
      workspacePath: atlasRoot,
      ownerId: userId,
      visibility: 'private',
      color: '#34d399',
      position: 1,
      createdAt: now - 32 * 86400e3,
    },
    {
      id: docsId,
      name: 'Docs',
      workspacePath: docsRoot,
      ownerId: userId,
      visibility: 'private',
      color: '#f472b6',
      position: 2,
      createdAt: now - 25 * 86400e3,
    },
  ])

  const offlineWorktreeId = randomUUID()
  const radarWorktreeId = randomUUID()
  await db.insert(worktrees).values([
    {
      id: offlineWorktreeId,
      projectId: nimbusId,
      name: 'feat/offline-cache',
      path: offlineCachePath,
      baseRef: 'main',
      createdBy: userId,
      createdAt: now - 3 * 86400e3,
    },
    {
      id: radarWorktreeId,
      projectId: nimbusId,
      name: 'feat/radar-prefetch',
      path: radarPath,
      baseRef: 'main',
      createdBy: userId,
      createdAt: now - 8 * 86400e3,
    },
  ])

  await db.insert(mcpServers).values([
    {
      id: randomUUID(),
      name: 'github',
      enabled: true,
      transport: JSON.stringify({
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-github'],
        env: {},
      }),
      createdAt: now - 20 * 86400e3,
      updatedAt: now - 20 * 86400e3,
    },
    {
      id: randomUUID(),
      name: 'playwright',
      enabled: true,
      transport: JSON.stringify({
        type: 'stdio',
        command: 'npx',
        args: ['-y', '@playwright/mcp@latest'],
        env: {},
      }),
      createdAt: now - 12 * 86400e3,
      updatedAt: now - 12 * 86400e3,
    },
  ])

  // ---- Cartes du board Nimbus -------------------------------------------------

  const cardRows = [
    { number: 1, title: 'Severe weather alerts', column: 'todo', position: 0, description: 'Push a notification when Open-Meteo flags a warning for a saved city. Needs a settings toggle per city.' },
    { number: 6, title: 'Dark mode for the map layer', column: 'todo', position: 1, description: 'The radar tiles stay light in dark mode and glow. Swap to the dark tile set when the theme changes.' },
    { number: 3, title: 'Hourly forecast chart', column: 'todo', position: 2, description: 'A 24h temperature and precipitation chart on the city detail view.' },
    { number: 7, title: 'Wind direction arrows on the map', column: 'todo', position: 3, description: 'Overlay animated arrows from the wind field. Same tile grid as the radar layer.' },
    { number: 10, title: 'City list virtualization', column: 'todo', position: 4, description: 'The city list re-renders every card on refresh. Follow-up of #2: reuse the cache timestamps to skip untouched rows.' },
    { number: 2, title: 'Offline caching for forecasts', column: 'in_progress', position: 0, description: 'The app goes blank without a connection. Cache the last forecast per city and show how old the data is.' },
    { number: 4, title: 'Radar map performance', column: 'review', position: 0, description: 'Tile prefetching landed on feat/radar-prefetch, needs a review pass on mobile.' },
    { number: 5, title: 'Onboarding flow', column: 'done', position: 0, description: 'First-run screen: pick a city, choose units, done.' },
    { number: 8, title: 'Switch to Vite 6', column: 'done', position: 1, description: 'Migration went through with no config change beyond the plugin bump.' },
    { number: 9, title: 'Android home-screen widget', column: 'abandoned', position: 0, description: 'Superseded by the PWA shortcut work; keeping the notes for reference.' },
  ] as const

  const cardIds = new Map<number, string>()
  for (const row of cardRows) {
    const id = randomUUID()
    cardIds.set(row.number, id)
    await db.insert(cards).values({
      id,
      projectId: nimbusId,
      number: row.number,
      title: row.title,
      description: row.description,
      column: row.column,
      position: row.position,
      createdBy: userId,
      createdAt: now - (14 - row.number) * 86400e3,
      updatedAt: now - 86400e3,
    })
  }
  // Le backlink de la description de la carte 10, qui cite #2.
  await db.insert(cardRefs).values({ sourceId: cardIds.get(10)!, targetId: cardIds.get(2)! })

  const atlasCardRows = [
    { number: 1, title: 'OpenAPI spec for /places', column: 'todo', position: 0, description: 'Publish the schema so Nimbus can generate its client.' },
    { number: 2, title: 'Nightly geonames refresh', column: 'todo', position: 1, description: 'The dump is loaded once at boot; refresh it on a schedule instead.' },
    { number: 3, title: 'Rate limiting', column: 'done', position: 0, description: '60 requests per minute per API key, 429 with Retry-After beyond.' },
  ] as const
  for (const row of atlasCardRows) {
    await db.insert(cards).values({
      id: randomUUID(),
      projectId: atlasId,
      number: row.number,
      title: row.title,
      description: row.description,
      column: row.column,
      position: row.position,
      createdBy: userId,
      createdAt: now - (8 - row.number) * 86400e3,
      updatedAt: now - 2 * 86400e3,
    })
  }

  // ---- Conversations ----------------------------------------------------------

  interface ConversationSeed {
    projectId: string
    worktreeId?: string
    cardId?: string
    title: string
    agent: 'claude' | 'codex'
    model: string
    config: Record<string, unknown>
    status: 'idle' | 'running' | 'awaiting_input' | 'interrupted'
    ageDays: number
    /** Durée totale du fil en secondes, pour étaler les horodatages. */
    spanSec: number
    costUsd: number
    inputTokens: number
    outputTokens: number
    contextUsed?: number
    contextMax?: number
    /** Laisser du non-lu sur ce fil, pour montrer l'indicateur. */
    unread?: boolean
    events: SeededEvent[]
  }

  const claudeConfig = {
    agent: 'claude',
    model: 'claude-sonnet-5',
    effort: 'medium',
    permissionMode: 'manual',
    additionalDirectories: [],
    mcpServers: [],
    sillageMcp: true,
    strictMcp: false,
  }
  const codexConfig = {
    agent: 'codex',
    model: 'gpt-5.2-codex',
    reasoningEffort: 'medium',
    askForApproval: 'on-request',
    collaborationMode: 'default',
    sandbox: 'workspace-write',
    webSearch: false,
    profile: null,
    additionalDirectories: [],
    mcpServers: [],
    sillageMcp: true,
  }

  const toolCallIds = { read: 'toolu_demo_read_forecast', grep: 'toolu_demo_grep_fetch', edit: 'toolu_demo_edit_forecast', write: 'toolu_demo_write_cache', bash: 'toolu_demo_bash_test', edit2: 'toolu_demo_edit_citylist' }

  const forecastReadOutput = `1\texport interface Forecast {
2\t  city: string
3\t  temperatureC: number
4\t  summary: string
5\t  fetchedAt: number
6\t}
7\t
8\tconst API_BASE = 'https://api.open-meteo.com/v1'
9\t
10\texport async function fetchForecast(city: string): Promise<Forecast> {
11\t  const response = await fetch(\`\${API_BASE}/forecast?city=\${encodeURIComponent(city)}\`)
12\t  if (!response.ok) throw new Error(\`Forecast request failed: \${response.status}\`)
13\t  const data = await response.json()
14\t  return {
15\t    city,
16\t    temperatureC: data.current.temperature_2m,
17\t    summary: data.current.summary,
18\t    fetchedAt: Date.now(),
19\t  }
20\t}`

  const heroEvents: SeededEvent[] = [
    {
      at: 0,
      event: {
        type: 'session.started',
        agent: 'claude',
        agentSessionId: randomUUID(),
        model: 'claude-sonnet-5',
        cwd: offlineCachePath,
        tools: CLAUDE_TOOLS,
      },
    },
    {
      at: 1,
      event: {
        type: 'message.completed',
        messageId: 'msg_user_1',
        role: 'user',
        blocks: [
          {
            type: 'text',
            text: 'The app goes blank as soon as the connection drops. Cache the last forecast per city and serve it when the network is down, with a small badge showing how old the data is.',
          },
        ],
        parentToolCallId: null,
      },
    },
    { at: 2, event: { type: 'turn.started' } },
    {
      at: 6,
      event: {
        type: 'plan.updated',
        items: [
          { text: 'Audit the current fetch layer', status: 'completed' },
          { text: 'Add a per-city forecast cache', status: 'completed' },
          { text: 'Serve cached data on network failure', status: 'completed' },
          { text: 'Show a "cached" badge with data age', status: 'in_progress' },
          { text: 'Run the forecast test suite', status: 'pending' },
        ],
      },
    },
    {
      at: 8,
      event: {
        type: 'message.completed',
        messageId: 'msg_a1',
        role: 'assistant',
        blocks: [
          {
            type: 'text',
            text: "I'll start by looking at how forecasts are fetched today, then add a cache layer that the fetch path falls back to.",
          },
        ],
        parentToolCallId: null,
      },
    },
    { at: 10, event: { type: 'tool.started', toolCallId: toolCallIds.read, name: 'Read', input: { file_path: 'src/lib/forecast.ts' }, parentToolCallId: null } },
    { at: 11, event: { type: 'tool.completed', toolCallId: toolCallIds.read, output: forecastReadOutput, isError: false, durationMs: 240 } },
    { at: 13, event: { type: 'tool.started', toolCallId: toolCallIds.grep, name: 'Grep', input: { pattern: 'fetchForecast', output_mode: 'files_with_matches' }, parentToolCallId: null } },
    {
      at: 14,
      event: { type: 'tool.completed', toolCallId: toolCallIds.grep, output: 'src/lib/forecast.ts\nsrc/components/CityList.tsx', isError: false, durationMs: 180 },
    },
    {
      at: 18,
      event: {
        type: 'message.completed',
        messageId: 'msg_a2',
        role: 'assistant',
        blocks: [
          {
            type: 'text',
            text: '`fetchForecast` is called from `CityList` only, so a fallback inside the fetch layer covers every caller. Writing the cache module now.',
          },
        ],
        parentToolCallId: null,
      },
    },
    {
      at: 22,
      event: {
        type: 'tool.started',
        toolCallId: toolCallIds.write,
        name: 'Write',
        input: {
          file_path: 'src/lib/forecast-cache.ts',
          content: `import type { Forecast } from './forecast'

const STORE = 'nimbus.forecasts'

export function rememberForecast(forecast: Forecast): void {
  const cached = readAll()
  cached[forecast.city] = forecast
  localStorage.setItem(STORE, JSON.stringify(cached))
}

export function lastKnownForecast(city: string): Forecast | null {
  return readAll()[city] ?? null
}
`,
        },
        parentToolCallId: null,
      },
    },
    { at: 23, event: { type: 'file.edited', toolCallId: toolCallIds.write, path: 'src/lib/forecast-cache.ts', action: 'created' } },
    { at: 23, event: { type: 'tool.completed', toolCallId: toolCallIds.write, output: 'File created successfully at src/lib/forecast-cache.ts', isError: false, durationMs: 310 } },
    {
      at: 27,
      event: {
        type: 'tool.started',
        toolCallId: toolCallIds.edit,
        name: 'Edit',
        input: {
          file_path: 'src/lib/forecast.ts',
          old_string: `  const response = await fetch(\`\${API_BASE}/forecast?city=\${encodeURIComponent(city)}\`)
  if (!response.ok) throw new Error(\`Forecast request failed: \${response.status}\`)`,
          new_string: `  let response: Response
  try {
    response = await fetch(\`\${API_BASE}/forecast?city=\${encodeURIComponent(city)}\`)
  } catch (error) {
    const cached = lastKnownForecast(city)
    if (cached) return { ...cached, fromCache: true }
    throw error
  }
  if (!response.ok) throw new Error(\`Forecast request failed: \${response.status}\`)`,
        },
        parentToolCallId: null,
      },
    },
    { at: 28, event: { type: 'file.edited', toolCallId: toolCallIds.edit, path: 'src/lib/forecast.ts', action: 'modified' } },
    { at: 28, event: { type: 'tool.completed', toolCallId: toolCallIds.edit, output: 'The file src/lib/forecast.ts has been updated.', isError: false, durationMs: 150 } },
    {
      at: 30,
      event: {
        type: 'diff.updated',
        files: [
          { path: 'src/lib/forecast.ts', added: 14, removed: 2 },
          { path: 'src/lib/forecast-cache.ts', added: 24, removed: 0 },
          { path: 'src/components/ForecastCard.tsx', added: 9, removed: 1 },
        ],
      },
    },
    { at: 33, event: { type: 'tool.started', toolCallId: toolCallIds.bash, name: 'Bash', input: { command: 'pnpm test -- forecast', description: 'Run the forecast test suite' }, parentToolCallId: null } },
    {
      at: 41,
      event: {
        type: 'tool.completed',
        toolCallId: toolCallIds.bash,
        output: `> nimbus@0.9.0 test
> vitest run forecast

 ✓ src/lib/forecast.test.ts (6 tests) 312ms
   ✓ returns the live forecast when the network is up
   ✓ falls back to the cached forecast when fetch rejects
   ✓ marks cached results with fromCache
   ✓ throws when there is no cache to fall back to

 Test Files  1 passed (1)
      Tests  6 passed (6)`,
        isError: false,
        durationMs: 8340,
      },
    },
    {
      at: 44,
      event: {
        type: 'plan.updated',
        items: [
          { text: 'Audit the current fetch layer', status: 'completed' },
          { text: 'Add a per-city forecast cache', status: 'completed' },
          { text: 'Serve cached data on network failure', status: 'completed' },
          { text: 'Show a "cached" badge with data age', status: 'completed' },
          { text: 'Run the forecast test suite', status: 'completed' },
        ],
      },
    },
    {
      at: 47,
      event: {
        type: 'message.completed',
        messageId: 'msg_a3',
        role: 'assistant',
        blocks: [
          {
            type: 'text',
            text: `Offline fallback is in place and tested. What changed:

- **\`src/lib/forecast-cache.ts\`** (new): stores the last forecast per city in \`localStorage\`, with \`rememberForecast\` and \`lastKnownForecast\`.
- **\`src/lib/forecast.ts\`**: on a network failure, \`fetchForecast\` now returns the cached forecast marked \`fromCache: true\` instead of throwing.
- **\`src/components/ForecastCard.tsx\`**: shows a subtle "cached · 12 min ago" badge when the data is stale.

All 6 forecast tests pass, including the two new offline cases.`,
          },
        ],
        parentToolCallId: null,
      },
    },
    { at: 48, event: { type: 'usage.updated', costUsd: 0.4812, inputTokens: 24, outputTokens: 3120, context: { usedTokens: 38400, maxTokens: 200000, ratio: 0.19 } } },
    { at: 49, event: { type: 'turn.completed', stopReason: 'success', costUsd: 0.4812, inputTokens: 24, outputTokens: 3120, cacheCreationTokens: 18200, cacheReadTokens: 96400 } },
    {
      at: 55,
      event: {
        type: 'message.completed',
        messageId: 'msg_user_2',
        role: 'user',
        blocks: [
          { type: 'text', text: 'Nice. Show the age in the city list too, not just on the detail card.' },
        ],
        parentToolCallId: null,
      },
    },
    { at: 56, event: { type: 'turn.started' } },
    {
      at: 58,
      event: {
        type: 'tool.started',
        toolCallId: toolCallIds.edit2,
        name: 'Edit',
        input: {
          file_path: 'src/components/CityList.tsx',
          old_string: '<ForecastCard key={forecast.city} forecast={forecast} />',
          new_string: '<ForecastCard key={forecast.city} forecast={forecast} showAge />',
        },
        parentToolCallId: null,
      },
    },
    { at: 59, event: { type: 'file.edited', toolCallId: toolCallIds.edit2, path: 'src/components/CityList.tsx', action: 'modified' } },
    { at: 60, event: { type: 'tool.completed', toolCallId: toolCallIds.edit2, output: 'The file src/components/CityList.tsx has been updated.', isError: false, durationMs: 140 } },
    { at: 61, event: { type: 'message.delta', messageId: 'msg_a4', text: 'Done, the list rows now carry the same badge. Wiring the age formatting through ', parentToolCallId: null } },
  ]

  const retryEvents: SeededEvent[] = [
    {
      at: 0,
      event: {
        type: 'session.started',
        agent: 'codex',
        agentSessionId: randomUUID(),
        model: 'gpt-5.2-codex',
        cwd: atlasRoot,
        tools: [],
      },
    },
    {
      at: 1,
      event: {
        type: 'message.completed',
        messageId: 'msg_user_1',
        role: 'user',
        blocks: [
          { type: 'text', text: 'places.test.ts fails about once every ten CI runs on the retry case. Find out why and fix it.' },
        ],
        parentToolCallId: null,
      },
    },
    { at: 2, event: { type: 'turn.started' } },
    { at: 5, event: { type: 'tool.started', toolCallId: 'toolu_retry_read', name: 'Read', input: { file_path: 'src/lib/search.test.ts' }, parentToolCallId: null } },
    { at: 6, event: { type: 'tool.completed', toolCallId: 'toolu_retry_read', output: '1\timport { describe, expect, it, vi } from "vitest"\n…', isError: false, durationMs: 210 } },
    {
      at: 12,
      event: {
        type: 'tool.started',
        toolCallId: 'toolu_retry_edit',
        name: 'Edit',
        input: {
          file_path: 'src/lib/search.test.ts',
          old_string: 'await new Promise((r) => setTimeout(r, 50))',
          new_string: 'await vi.advanceTimersByTimeAsync(50)',
        },
        parentToolCallId: null,
      },
    },
    { at: 13, event: { type: 'file.edited', toolCallId: 'toolu_retry_edit', path: 'src/lib/search.test.ts', action: 'modified' } },
    { at: 13, event: { type: 'tool.completed', toolCallId: 'toolu_retry_edit', output: 'Updated.', isError: false, durationMs: 120 } },
    { at: 16, event: { type: 'tool.started', toolCallId: 'toolu_retry_bash', name: 'Bash', input: { command: 'pnpm test -- --repeat 30 search' }, parentToolCallId: null } },
    { at: 45, event: { type: 'tool.completed', toolCallId: 'toolu_retry_bash', output: ' Test Files  1 passed (1)\n      Tests  240 passed (240)', isError: false, durationMs: 29000 } },
    {
      at: 48,
      event: {
        type: 'message.completed',
        messageId: 'msg_a1',
        role: 'assistant',
        blocks: [
          {
            type: 'text',
            text: 'The test raced a real 50ms timer against the mocked retry clock. It now advances the fake timer instead, and 30 repeated runs all pass.',
          },
        ],
        parentToolCallId: null,
      },
    },
    { at: 49, event: { type: 'turn.completed', stopReason: 'success', costUsd: 0.0841, inputTokens: 12, outputTokens: 980, cacheCreationTokens: 4200, cacheReadTokens: 31000 } },
  ]

  const permissionRequestId = randomUUID()
  const settingsEvents: SeededEvent[] = [
    {
      at: 0,
      event: {
        type: 'session.started',
        agent: 'claude',
        agentSessionId: randomUUID(),
        model: 'claude-sonnet-5',
        cwd: nimbusRoot,
        tools: CLAUDE_TOOLS,
      },
    },
    {
      at: 1,
      event: {
        type: 'message.completed',
        messageId: 'msg_user_1',
        role: 'user',
        blocks: [
          { type: 'text', text: 'Settings are scattered across three localStorage keys. Consolidate them into one versioned object with a migration for existing users.' },
        ],
        parentToolCallId: null,
      },
    },
    { at: 2, event: { type: 'turn.started' } },
    { at: 8, event: { type: 'tool.started', toolCallId: 'toolu_settings_write', name: 'Write', input: { file_path: 'src/lib/settings.ts', content: '// versioned settings store…' }, parentToolCallId: null } },
    { at: 9, event: { type: 'file.edited', toolCallId: 'toolu_settings_write', path: 'src/lib/settings.ts', action: 'created' } },
    { at: 9, event: { type: 'tool.completed', toolCallId: 'toolu_settings_write', output: 'File created successfully at src/lib/settings.ts', isError: false, durationMs: 260 } },
    {
      at: 14,
      event: {
        type: 'message.completed',
        messageId: 'msg_a1',
        role: 'assistant',
        blocks: [
          { type: 'text', text: 'The store and migration are written. I need to run the migration script once against a browser profile to verify the three legacy keys merge cleanly.' },
        ],
        parentToolCallId: null,
      },
    },
    {
      at: 15,
      event: {
        type: 'permission.requested',
        requestId: permissionRequestId,
        toolName: 'Bash',
        input: { command: 'node scripts/migrate-settings.mjs --dry-run', description: 'Dry-run the settings migration' },
        title: null,
        description: 'node scripts/migrate-settings.mjs --dry-run',
        displayName: 'Bash',
        suggestions: [
          { id: 'allow-once', label: 'Allow', scope: 'once', behavior: 'allow' },
          { id: 'allow-session', label: 'Allow for this session', scope: 'session', behavior: 'allow' },
          { id: 'deny', label: 'Deny', scope: 'once', behavior: 'deny' },
        ],
      },
    },
  ]

  const releaseEvents: SeededEvent[] = [
    {
      at: 0,
      event: {
        type: 'session.started',
        agent: 'claude',
        agentSessionId: randomUUID(),
        model: 'claude-sonnet-5',
        cwd: nimbusRoot,
        tools: CLAUDE_TOOLS,
      },
    },
    {
      at: 1,
      event: {
        type: 'message.completed',
        messageId: 'msg_user_1',
        role: 'user',
        blocks: [{ type: 'text', text: 'Draft the release notes for v0.9 from the merged PRs since v0.8.' }],
        parentToolCallId: null,
      },
    },
    { at: 2, event: { type: 'turn.started' } },
    { at: 4, event: { type: 'tool.started', toolCallId: 'toolu_rel_bash', name: 'Bash', input: { command: 'git log --oneline v0.8.0..HEAD' }, parentToolCallId: null } },
    { at: 5, event: { type: 'tool.completed', toolCallId: 'toolu_rel_bash', output: 'f3a91c2 Onboarding flow\n8bd0e17 Switch radar tiles to vector\n41c99ab Per-city units', isError: false, durationMs: 380 } },
    {
      at: 20,
      event: {
        type: 'message.completed',
        messageId: 'msg_a1',
        role: 'assistant',
        blocks: [
          {
            type: 'text',
            text: `## Nimbus v0.9

### Highlights
- **Onboarding flow**: first launch walks you through picking a city and units.
- **Vector radar tiles**: the radar map is sharper and loads about 40% faster.
- **Per-city units**: each saved city can now display °C or °F independently.

### Fixes
- Forecast cards no longer flash stale data while refreshing.`,
          },
        ],
        parentToolCallId: null,
      },
    },
    { at: 21, event: { type: 'turn.completed', stopReason: 'success', costUsd: 0.1104, inputTokens: 8, outputTokens: 1240, cacheCreationTokens: 5100, cacheReadTokens: 22000 } },
  ]

  const rateLimitEvents: SeededEvent[] = [
    {
      at: 0,
      event: {
        type: 'session.started',
        agent: 'codex',
        agentSessionId: randomUUID(),
        model: 'gpt-5.2-codex',
        cwd: atlasRoot,
        tools: [],
      },
    },
    {
      at: 1,
      event: {
        type: 'message.completed',
        messageId: 'msg_user_1',
        role: 'user',
        blocks: [{ type: 'text', text: 'Add a rate limit on /places: 60 requests per minute per API key, 429 with a Retry-After header beyond that.' }],
        parentToolCallId: null,
      },
    },
    { at: 2, event: { type: 'turn.started' } },
    { at: 6, event: { type: 'tool.started', toolCallId: 'toolu_rate_write', name: 'Write', input: { file_path: 'src/plugins/rate-limit.ts', content: '// sliding window limiter…' }, parentToolCallId: null } },
    { at: 7, event: { type: 'file.edited', toolCallId: 'toolu_rate_write', path: 'src/plugins/rate-limit.ts', action: 'created' } },
    { at: 7, event: { type: 'tool.completed', toolCallId: 'toolu_rate_write', output: 'File created successfully at src/plugins/rate-limit.ts', isError: false, durationMs: 290 } },
    {
      at: 15,
      event: {
        type: 'message.completed',
        messageId: 'msg_a1',
        role: 'assistant',
        blocks: [
          { type: 'text', text: 'Sliding-window limiter added as a Fastify plugin, keyed by API key with an in-memory store. 429 responses carry `Retry-After` in seconds.' },
        ],
        parentToolCallId: null,
      },
    },
    { at: 16, event: { type: 'turn.completed', stopReason: 'success', costUsd: 0.0632, inputTokens: 9, outputTokens: 720, cacheCreationTokens: 3600, cacheReadTokens: 18400 } },
  ]

  /**
   * Journal minimal mais rejouable : un tour complet avec au plus un appel d'outil.
   * Suffisant pour les fils que les captures ne font qu'apercevoir dans la sidebar.
   */
  function simpleThread(input: {
    agent: 'claude' | 'codex'
    model: string
    cwd: string
    user: string
    tool?: {
      name: string
      input: unknown
      output: string
      durationMs: number
      file?: { path: string; action: 'created' | 'modified' | 'deleted' }
    }
    assistant: string
    costUsd: number
    outputTokens: number
  }): SeededEvent[] {
    const toolCallId = `toolu_demo_${randomUUID().slice(0, 8)}`
    const thread: SeededEvent[] = [
      {
        at: 0,
        event: {
          type: 'session.started',
          agent: input.agent,
          agentSessionId: randomUUID(),
          model: input.model,
          cwd: input.cwd,
          tools: input.agent === 'claude' ? CLAUDE_TOOLS : [],
        },
      },
      {
        at: 1,
        event: {
          type: 'message.completed',
          messageId: 'msg_user_1',
          role: 'user',
          blocks: [{ type: 'text', text: input.user }],
          parentToolCallId: null,
        },
      },
      { at: 2, event: { type: 'turn.started' } },
    ]
    if (input.tool) {
      thread.push({
        at: 5,
        event: {
          type: 'tool.started',
          toolCallId,
          name: input.tool.name,
          input: input.tool.input,
          parentToolCallId: null,
        },
      })
      if (input.tool.file) {
        thread.push({
          at: 6,
          event: { type: 'file.edited', toolCallId, path: input.tool.file.path, action: input.tool.file.action },
        })
      }
      thread.push({
        at: 6,
        event: {
          type: 'tool.completed',
          toolCallId,
          output: input.tool.output,
          isError: false,
          durationMs: input.tool.durationMs,
        },
      })
    }
    thread.push(
      {
        at: 12,
        event: {
          type: 'message.completed',
          messageId: 'msg_a1',
          role: 'assistant',
          blocks: [{ type: 'text', text: input.assistant }],
          parentToolCallId: null,
        },
      },
      {
        at: 13,
        event: {
          type: 'turn.completed',
          stopReason: 'success',
          costUsd: input.costUsd,
          inputTokens: 10,
          outputTokens: input.outputTokens,
          cacheCreationTokens: 3000,
          cacheReadTokens: 15000,
        },
      },
    )
    return thread
  }

  const seeds: ConversationSeed[] = [
    {
      projectId: nimbusId,
      worktreeId: offlineWorktreeId,
      cardId: cardIds.get(2),
      title: 'Add offline caching for forecasts',
      agent: 'claude',
      model: 'claude-sonnet-5',
      config: claudeConfig,
      status: 'running',
      ageDays: 0,
      spanSec: 65,
      costUsd: 0.4812,
      inputTokens: 24,
      outputTokens: 3120,
      contextUsed: 38400,
      contextMax: 200000,
      events: heroEvents,
    },
    {
      projectId: nimbusId,
      title: 'Refactor settings storage',
      agent: 'claude',
      model: 'claude-sonnet-5',
      config: claudeConfig,
      status: 'awaiting_input',
      ageDays: 0,
      spanSec: 16,
      costUsd: 0.1922,
      inputTokens: 14,
      outputTokens: 1610,
      contextUsed: 21400,
      contextMax: 200000,
      events: settingsEvents,
    },
    {
      projectId: nimbusId,
      title: 'Release notes for v0.9',
      agent: 'claude',
      model: 'claude-sonnet-5',
      config: claudeConfig,
      status: 'idle',
      ageDays: 1,
      spanSec: 21,
      costUsd: 0.1104,
      inputTokens: 8,
      outputTokens: 1240,
      unread: true,
      events: releaseEvents,
    },
    {
      projectId: atlasId,
      title: 'Fix the flaky retry test',
      agent: 'codex',
      model: 'gpt-5.2-codex',
      config: codexConfig,
      status: 'idle',
      ageDays: 2,
      spanSec: 49,
      costUsd: 0.0841,
      inputTokens: 12,
      outputTokens: 980,
      events: retryEvents,
    },
    {
      projectId: atlasId,
      title: 'Rate-limit the places endpoint',
      agent: 'codex',
      model: 'gpt-5.2-codex',
      config: codexConfig,
      status: 'idle',
      ageDays: 4,
      spanSec: 16,
      costUsd: 0.0632,
      inputTokens: 9,
      outputTokens: 720,
      events: rateLimitEvents,
    },
    {
      projectId: nimbusId,
      worktreeId: radarWorktreeId,
      cardId: cardIds.get(4),
      title: 'Radar tile prefetching',
      agent: 'claude',
      model: 'claude-sonnet-5',
      config: claudeConfig,
      status: 'idle',
      ageDays: 6,
      spanSec: 13,
      costUsd: 0.3418,
      inputTokens: 18,
      outputTokens: 2450,
      events: simpleThread({
        agent: 'claude',
        model: 'claude-sonnet-5',
        cwd: radarPath,
        user: 'Panning the radar map shows blank tiles for a second. Prefetch the ring of tiles around the viewport.',
        tool: {
          name: 'Write',
          input: { file_path: 'src/lib/radar-prefetch.ts', content: '// ring prefetch…' },
          output: 'File created successfully at src/lib/radar-prefetch.ts',
          durationMs: 280,
          file: { path: 'src/lib/radar-prefetch.ts', action: 'created' },
        },
        assistant:
          'Prefetching is in: `tilesToPrefetch` computes the ring around the viewport and the map layer warms those tiles on idle. Panning one screen in any direction no longer shows blanks. Worth a review pass on mobile, where the tile budget is tighter.',
        costUsd: 0.3418,
        outputTokens: 2450,
      }),
    },
    {
      projectId: nimbusId,
      title: 'Migrate icons to Lucide',
      agent: 'claude',
      model: 'claude-sonnet-5',
      config: claudeConfig,
      status: 'idle',
      ageDays: 3,
      spanSec: 13,
      costUsd: 0.2216,
      inputTokens: 16,
      outputTokens: 1830,
      events: simpleThread({
        agent: 'claude',
        model: 'claude-sonnet-5',
        cwd: nimbusRoot,
        user: 'Replace the hand-rolled SVG icons with lucide-react, keeping the same sizes.',
        tool: {
          name: 'Bash',
          input: { command: 'pnpm add lucide-react', description: 'Install lucide-react' },
          output: 'dependencies:\n+ lucide-react 0.488.0\n\nDone in 2.1s',
          durationMs: 2140,
        },
        assistant:
          'All 14 icons now come from `lucide-react` at the same 16/20px sizes, and the `icons/` folder is gone. Bundle is 3.2 kB lighter after tree-shaking.',
        costUsd: 0.2216,
        outputTokens: 1830,
      }),
    },
    {
      projectId: nimbusId,
      title: 'Investigate slow first paint',
      agent: 'claude',
      model: 'claude-sonnet-5',
      config: claudeConfig,
      status: 'interrupted',
      ageDays: 5,
      spanSec: 13,
      costUsd: 0.1573,
      inputTokens: 11,
      outputTokens: 1220,
      unread: true,
      events: simpleThread({
        agent: 'claude',
        model: 'claude-sonnet-5',
        cwd: nimbusRoot,
        user: 'Lighthouse gives us 2.8s first contentful paint on mobile. Find out where it goes.',
        tool: {
          name: 'Bash',
          input: { command: 'pnpm build && du -sh dist/assets/*', description: 'Build and measure bundles' },
          output: 'dist/assets/index-C3k9d2.js  412K\ndist/assets/map-vendor-8fkq1.js  926K',
          durationMs: 14200,
        },
        assistant:
          'The map vendor chunk is 926 kB and loads before anything renders. Splitting it behind the first map interaction should cut FCP roughly in half; I was starting on the dynamic import when we stopped.',
        costUsd: 0.1573,
        outputTokens: 1220,
      }),
    },
    {
      projectId: nimbusId,
      title: 'Playwright smoke tests',
      agent: 'codex',
      model: 'gpt-5.2-codex',
      config: codexConfig,
      status: 'idle',
      ageDays: 9,
      spanSec: 13,
      costUsd: 0.0914,
      inputTokens: 8,
      outputTokens: 860,
      events: simpleThread({
        agent: 'codex',
        model: 'gpt-5.2-codex',
        cwd: nimbusRoot,
        user: 'Add a Playwright smoke test: app boots, three cities render, detail view opens.',
        tool: {
          name: 'Write',
          input: { file_path: 'e2e/smoke.spec.ts', content: '// boot + city list + detail…' },
          output: 'File created successfully at e2e/smoke.spec.ts',
          durationMs: 320,
          file: { path: 'e2e/smoke.spec.ts', action: 'created' },
        },
        assistant:
          'Smoke suite added with three scenarios, wired into CI as a required check. It waits on the forecast cards themselves, not on network idle, so it stays stable offline.',
        costUsd: 0.0914,
        outputTokens: 860,
      }),
    },
    {
      projectId: atlasId,
      title: 'Add /health and request metrics',
      agent: 'claude',
      model: 'claude-sonnet-5',
      config: claudeConfig,
      status: 'idle',
      ageDays: 7,
      spanSec: 13,
      costUsd: 0.1187,
      inputTokens: 9,
      outputTokens: 1040,
      events: simpleThread({
        agent: 'claude',
        model: 'claude-sonnet-5',
        cwd: atlasRoot,
        user: 'Add a /health endpoint and basic request metrics we can scrape.',
        tool: {
          name: 'Write',
          input: { file_path: 'src/routes/health.ts', content: '// health + metrics…' },
          output: 'File created successfully at src/routes/health.ts',
          durationMs: 240,
          file: { path: 'src/routes/health.ts', action: 'created' },
        },
        assistant:
          '`/health` reports uptime and the geonames dump age; `/metrics` exposes request counts and p95 latency per route in Prometheus format.',
        costUsd: 0.1187,
        outputTokens: 1040,
      }),
    },
    {
      projectId: docsId,
      title: 'Write the quickstart guide',
      agent: 'claude',
      model: 'claude-sonnet-5',
      config: claudeConfig,
      status: 'idle',
      ageDays: 1,
      spanSec: 13,
      costUsd: 0.1349,
      inputTokens: 12,
      outputTokens: 1160,
      unread: true,
      events: simpleThread({
        agent: 'claude',
        model: 'claude-sonnet-5',
        cwd: docsRoot,
        user: 'Write a quickstart page: install, first run, adding a city. Short, with copy-pasteable commands.',
        tool: {
          name: 'Write',
          input: { file_path: 'src/pages/quickstart.md', content: '---\ntitle: Quickstart\n---\n…' },
          output: 'File created successfully at src/pages/quickstart.md',
          durationMs: 260,
          file: { path: 'src/pages/quickstart.md', action: 'created' },
        },
        assistant:
          'Quickstart is up: install, dev server, adding your first city, each with a copy-pasteable block. It links to the units guide rather than repeating it.',
        costUsd: 0.1349,
        outputTokens: 1160,
      }),
    },
    {
      projectId: docsId,
      title: 'Dark mode for code blocks',
      agent: 'codex',
      model: 'gpt-5.2-codex',
      config: codexConfig,
      status: 'idle',
      ageDays: 3,
      spanSec: 13,
      costUsd: 0.0568,
      inputTokens: 7,
      outputTokens: 610,
      events: simpleThread({
        agent: 'codex',
        model: 'gpt-5.2-codex',
        cwd: docsRoot,
        user: 'Code blocks stay light in dark mode. Wire the syntax theme to the site theme.',
        tool: {
          name: 'Edit',
          input: {
            file_path: 'astro.config.mjs',
            old_string: "site: 'https://docs.nimbus.example',",
            new_string: "site: 'https://docs.nimbus.example',\n  markdown: { shikiConfig: { themes: { light: 'github-light', dark: 'github-dark' } } },",
          },
          output: 'The file astro.config.mjs has been updated.',
          durationMs: 150,
          file: { path: 'astro.config.mjs', action: 'modified' },
        },
        assistant:
          'Shiki now emits both palettes and the site theme toggles them with a CSS variable, so code blocks follow dark mode with no flash on load.',
        costUsd: 0.0568,
        outputTokens: 610,
      }),
    },
  ]

  let heroConversationId: string | null = null
  let position = 0
  for (const seed of seeds) {
    const conversationId = randomUUID()
    if (heroConversationId === null) heroConversationId = conversationId
    const start = now - seed.ageDays * 86400e3 - seed.spanSec * 1000
    const rows = seed.events.map((entry, index) => {
      const payload = JSON.stringify(entry.event)
      return {
        conversationId,
        seq: index + 1,
        ts: start + entry.at * 1000,
        type: entry.event.type,
        payload,
      }
    })
    const journalBytes = rows.reduce((total, row) => total + row.payload.length, 0)
    const turnCount = seed.events.filter(
      (entry) => entry.event.type === 'message.completed' && entry.event.role === 'user',
    ).length

    await db.insert(conversations).values({
      id: conversationId,
      projectId: seed.projectId,
      worktreeId: seed.worktreeId ?? null,
      cardId: seed.cardId ?? null,
      userId,
      title: seed.title,
      titleSetByUser: true,
      agent: seed.agent,
      agentSessionId: randomUUID(),
      config: JSON.stringify(seed.config),
      status: seed.status,
      lastSeq: rows.length,
      lastNotableSeq: rows.length,
      turnCount,
      journalBytes,
      contextUsedTokens: seed.contextUsed ?? null,
      contextMaxTokens: seed.contextMax ?? null,
      model: seed.model,
      costUsd: seed.costUsd,
      inputTokens: seed.inputTokens,
      outputTokens: seed.outputTokens,
      position: position++,
      createdAt: start,
      updatedAt: start + seed.spanSec * 1000,
    })
    await db.insert(events).values(rows)
    await db.insert(conversationReads).values({
      conversationId,
      userId,
      lastReadSeq: seed.unread ? Math.max(1, rows.length - 3) : rows.length,
      updatedAt: now,
    })
  }

  // La demande de permission en attente, telle que le serveur l'aurait posée.
  const settingsConversation = await db.select().from(conversations)
  const settingsRow = settingsConversation.find((c) => c.title === 'Refactor settings storage')
  if (settingsRow) {
    await db.insert(permissionRequests).values({
      id: permissionRequestId,
      conversationId: settingsRow.id,
      seq: settingsRow.lastSeq,
      toolName: 'Bash',
      input: JSON.stringify({ command: 'node scripts/migrate-settings.mjs --dry-run' }),
      status: 'pending',
      createdAt: now - 16000,
    })
  }

  // Une note de session sur la carte du chantier en cours.
  await db.insert(cardNotes).values({
    id: randomUUID(),
    cardId: cardIds.get(2)!,
    conversationId: heroConversationId,
    userId: null,
    body: 'Cache layer and offline fallback are in and tested. Left to do: the age badge in the city list, then a manual pass with the network throttled to offline in devtools.',
    createdAt: now - 3600e3,
  })

  sqlite.close()
  console.log(`Demo data seeded in ${config.paths.database}`)
  console.log(`Login: ${DEMO_USERNAME} / ${DEMO_PASSWORD}`)
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
