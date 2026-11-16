import { open, readdir, stat } from 'node:fs/promises'
import { join, posix } from 'node:path'
import {
  MAX_BENCHMARK_SHARE_RUN_BYTES,
  MAX_BENCHMARK_SHARE_RUN_FILES,
  deliverableKind,
  type BenchmarkExportBlocker,
  type BenchmarkExportMode,
} from '@sillage/protocol'
import { SKIPPED_DIRECTORIES } from './deliverables.js'

/**
 * Whether what a run produced can be shown without Sillage and without running anything: a page
 * made of plain files is copied and served as is, a project that needs a bundler, a dev server or
 * a backend is not. The verdict comes from the files alone, never from executing them.
 */

export interface RunFile {
  /** Relative to the run folder, slash-separated. */
  path: string
  sizeBytes: number
}

export interface RunAssessment {
  mode: BenchmarkExportMode
  reason: BenchmarkExportBlocker | null
  entry: string | null
  /** What a snapshot copies: everything listed for a page, the displayable files otherwise. */
  files: RunFile[]
  bytes: number
}

/** Folders a build writes its static result into, tried when the top-level page is a source entry. */
const BUILD_OUTPUTS = ['dist', 'build', 'out', 'public', '_site', 'docs']

/** Manifests of a program that runs on a server rather than in the reader's browser. */
const SERVER_MANIFESTS = new Set([
  'requirements.txt', 'pyproject.toml', 'Pipfile', 'manage.py', 'go.mod', 'Cargo.toml', 'Gemfile',
  'composer.json', 'pom.xml', 'build.gradle', 'Dockerfile', 'docker-compose.yml', 'compose.yaml',
])

const SERVER_PACKAGES = /"(express|fastify|koa|hono|@nestjs\/core|next|nuxt|@remix-run\/[\w-]+|@sveltejs\/kit|astro|socket\.io|ws|better-sqlite3|pg|mysql2|mongoose|prisma)"\s*:/
const BUILD_PACKAGES = /"(vite|webpack|parcel|rollup|esbuild|react-scripts|@angular\/cli|@vue\/cli-service|svelte|typescript|tailwindcss|sass)"\s*:/

/** Reading sources to judge them stays bounded: a verdict must not cost more than the copy. */
const MAX_SCANNED_BYTES = 512 * 1024
const MAX_SCANNED_SCRIPTS = 24

async function head(absolute: string, max = MAX_SCANNED_BYTES): Promise<string> {
  const handle = await open(absolute, 'r').catch(() => null)
  if (!handle) return ''
  try {
    const buffer = Buffer.alloc(max)
    const { bytesRead } = await handle.read(buffer, 0, max, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

/**
 * Every file of the folder under the same rules as the deliverables list (no hidden files, no
 * tooling folders, no symlinks), without its display cap: a page needs all its assets. Null once
 * a limit is passed.
 */
export async function walkRunFolder(root: string): Promise<RunFile[] | null> {
  const files: RunFile[] = []
  let bytes = 0
  const queue: string[] = ['']
  while (queue.length > 0) {
    const relative = queue.shift()!
    const entries = await readdir(join(root, relative), { withFileTypes: true }).catch(() => [])
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRECTORIES.has(entry.name)) queue.push(path)
        continue
      }
      if (!entry.isFile()) continue
      const info = await stat(join(root, path)).catch(() => null)
      if (!info) continue
      bytes += info.size
      files.push({ path, sizeBytes: info.size })
      if (files.length > MAX_BENCHMARK_SHARE_RUN_FILES || bytes > MAX_BENCHMARK_SHARE_RUN_BYTES) return null
    }
  }
  return files
}

/** Shallowest first, `index.html` before its siblings: the page a static host would open. */
function byEntryOrder(a: string, b: string): number {
  const depth = a.split('/').length - b.split('/').length
  if (depth !== 0) return depth
  const index = Number(!/(^|\/)index\.html?$/i.test(a)) - Number(!/(^|\/)index\.html?$/i.test(b))
  return index !== 0 ? index : a.localeCompare(b)
}

/**
 * A page that only works once a bundler rewrote it: scripts in TypeScript or JSX, stylesheets in
 * a preprocessor language, or module imports by package name with no import map to resolve them.
 */
export function pageNeedsBuild(html: string): boolean {
  if (/<script\b[^>]*\bsrc\s*=\s*["'][^"']+\.(tsx?|jsx)(\?[^"']*)?["']/i.test(html)) return true
  if (/<link\b[^>]*\bhref\s*=\s*["'][^"']+\.(scss|sass|less|styl)["']/i.test(html)) return true
  if (/<script\b[^>]*\btype\s*=\s*["']importmap["']/i.test(html)) return false
  for (const match of html.matchAll(/<script\b[^>]*\btype\s*=\s*["']module["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    if (/\b(?:import|from)\s*["'](?![./]|https?:|data:|blob:)[^"']+["']/.test(match[1] ?? '')) return true
  }
  return false
}

/**
 * Requests a page sends to its own host, as written in its sources: `/api/todos`, a WebSocket, a
 * localhost port. Only string literals are seen; that is where a generated page puts them.
 */
function sameHostRequests(source: string): string[] {
  const found: string[] = []
  for (const match of source.matchAll(/\b(?:fetch|axios(?:\.\w+)?|EventSource|WebSocket)\s*\(\s*["'`]([^"'`$]+)/g)) {
    found.push(match[1]!)
  }
  for (const match of source.matchAll(/["'`](?:https?|wss?):\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?[^"'`]*/g)) {
    found.push(match[0].slice(1))
  }
  return found
}

function directoryOf(path: string): string {
  const dir = posix.dirname(path)
  return dir === '.' ? '' : dir
}

/** True when the page calls something that is not one of its own files: a backend has to answer. */
async function callsBackend(root: string, entry: string, files: RunFile[]): Promise<boolean> {
  const known = new Set(files.map((file) => file.path))
  const base = directoryOf(entry)
  const scripts = files
    .filter((file) => /\.(m?js)$/i.test(file.path) && file.path.startsWith(base) && file.sizeBytes <= MAX_SCANNED_BYTES)
    .slice(0, MAX_SCANNED_SCRIPTS)
  const sources = await Promise.all([entry, ...scripts.map((file) => file.path)].map((path) => head(join(root, path))))

  for (const target of sources.flatMap(sameHostRequests)) {
    if (/^(?:https?|wss?):\/\/(?:localhost|127\.0\.0\.1)/.test(target)) return true
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue
    const clean = target.split(/[?#]/)[0] ?? ''
    if (!clean) continue
    const resolved = clean.startsWith('/') ? posix.join(base, clean.slice(1)) : posix.join(base, clean)
    if (!known.has(posix.normalize(resolved))) return true
  }
  return false
}

interface Tooling {
  server: boolean
  build: boolean
}

async function detectTooling(root: string, files: RunFile[]): Promise<Tooling> {
  const top = files.filter((file) => !file.path.includes('/'))
  let server = top.some((file) => SERVER_MANIFESTS.has(file.path) || /\.(py|go|rs|rb|php|java|cs)$/i.test(file.path))
  let build = top.some((file) => /^(vite|webpack|rollup|next|nuxt|svelte|astro|tailwind)\.config\.\w+$/.test(file.path))
  if (top.some((file) => file.path === 'package.json')) {
    const manifest = await head(join(root, 'package.json'))
    server ||= SERVER_PACKAGES.test(manifest)
    build ||= BUILD_PACKAGES.test(manifest)
  }
  return { server, build }
}

const blocked = (reason: BenchmarkExportBlocker): RunAssessment => ({ mode: 'none', reason, entry: null, files: [], bytes: 0 })

const total = (files: RunFile[]) => files.reduce((sum, file) => sum + file.sizeBytes, 0)

export async function assessRunFolder(root: string | null): Promise<RunAssessment> {
  if (!root || !(await stat(root).catch(() => null))?.isDirectory()) return blocked('missing')
  const files = await walkRunFolder(root)
  if (!files) return blocked('too_large')
  if (files.length === 0) return blocked('empty')

  const tooling = await detectTooling(root, files)
  const pages = files.filter((file) => deliverableKind(file.path) === 'page').map((file) => file.path).sort(byEntryOrder)

  if (pages.length > 0) {
    let entry = pages[0]!
    if (pageNeedsBuild(await head(join(root, entry)))) {
      // A built copy next to the sources is the production: use it rather than give up.
      const built = pages.find((path) => BUILD_OUTPUTS.includes(path.split('/')[0]!) && /(^|\/)index\.html?$/i.test(path))
      if (!built || pageNeedsBuild(await head(join(root, built)))) return blocked('build')
      entry = built
    }
    // Only a project that ships a server is suspected of needing it: a static page fetching its
    // own JSON is common, and a missing file there is a bug of the page, not a backend.
    if (tooling.server && (await callsBackend(root, entry, files))) return blocked('server')
    // The whole folder goes along: nothing says which files the page loads at run time.
    return { mode: 'page', reason: null, entry, files, bytes: total(files) }
  }

  const media = files.filter((file) => ['image', 'audio', 'video', 'pdf'].includes(deliverableKind(file.path)))
  if (media.length === 0 && tooling.server) return blocked('server')
  if (media.length === 0 && tooling.build) return blocked('build')
  const shown = files.filter((file) => deliverableKind(file.path) !== 'other')
  if (shown.length === 0) return blocked('empty')
  return { mode: 'files', reason: null, entry: null, files: shown, bytes: total(shown) }
}
