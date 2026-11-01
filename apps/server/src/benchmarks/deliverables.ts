import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { deliverableKind, type BenchmarkDeliverable } from '@sillage/protocol'

/**
 * Directories an agent creates as tooling rather than output. Listing a `node_modules` would bury
 * the one page it built under thousands of files.
 */
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.cache', '.next', '.turbo'])

/** Enough for any deliverable a prompt asks for; the folder stays reachable from the run's conversation. */
export const MAX_DELIVERABLES = 300

/**
 * Files a run left in its folder, breadth-first so top-level outputs come before nested assets
 * when the cap is reached. Hidden files are skipped: a CLI's own state is not a deliverable.
 */
export async function listDeliverables(root: string, max = MAX_DELIVERABLES): Promise<BenchmarkDeliverable[]> {
  const found: BenchmarkDeliverable[] = []
  const queue: string[] = ['']
  while (queue.length > 0 && found.length < max) {
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
      // Symlinks are skipped too: the preview route refuses targets outside the folder anyway.
      if (!entry.isFile()) continue
      const info = await stat(join(root, path)).catch(() => null)
      if (!info) continue
      found.push({ path, sizeBytes: info.size, kind: deliverableKind(path) })
      if (found.length >= max) break
    }
  }
  return found
}

/**
 * Types served by the preview route. Wider than the panel's raw route because a built page needs
 * its scripts, styles and fonts; safe because every response carries a sandbox policy giving the
 * document an opaque origin.
 */
const PREVIEW_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  csv: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  opus: 'audio/ogg',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  ogv: 'video/ogg',
  mov: 'video/quicktime',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
}

export function previewType(path: string): string {
  const dot = path.lastIndexOf('.')
  const extension = dot >= 0 ? path.slice(dot + 1).toLowerCase() : ''
  // Text formats the comparison reads as source rather than render.
  if (deliverableKind(path) === 'text' && !PREVIEW_TYPES[extension]) return 'text/plain; charset=utf-8'
  return PREVIEW_TYPES[extension] ?? 'application/octet-stream'
}

/**
 * Policy on every preview response. `sandbox` without `allow-same-origin` gives the document an
 * opaque origin even when opened directly in a tab: it cannot read Sillage cookies or storage, and
 * its requests to the API carry no session (the cookie is SameSite=Lax).
 */
export const PREVIEW_POLICY = 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-pointer-lock allow-downloads'
