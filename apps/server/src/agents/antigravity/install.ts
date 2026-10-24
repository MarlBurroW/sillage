import { createHash } from 'node:crypto'
import { createReadStream, closeSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { Unzip, UnzipInflate } from 'fflate'
import { ANTIGRAVITY_DISTRIBUTION } from './distribution.js'

function writeAll(fd: number, chunk: Uint8Array): void {
  let offset = 0
  while (offset < chunk.byteLength) offset += writeSync(fd, chunk, offset, chunk.byteLength - offset)
}

/** Stream both download and extraction: the native harness exceeds the Desktop heap limit. */
export async function installAntigravity(prefix: string, version: string, progress: (message: string) => void): Promise<void> {
  const key = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : process.arch}`
  const release = ANTIGRAVITY_DISTRIBUTION[key as keyof typeof ANTIGRAVITY_DISTRIBUTION]
  if (!release) throw new Error(`Antigravity has no official archive for ${process.platform}/${process.arch}.`)
  const root = join(prefix, 'antigravity')
  await mkdir(root, { recursive: true })
  const stage = await mkdtemp(join(root, '.install-'))
  const archive = join(stage, 'archive.zip')
  const unpacked = join(stage, 'unpacked')
  const descriptors = new Set<number>()
  try {
    progress('Downloading Google Antigravity')
    const response = await fetch(release.archive, { signal: AbortSignal.timeout(15 * 60_000) })
    if (!response.ok || !response.body) throw new Error(`Google download returned HTTP ${response.status}.`)
    const hash = createHash('sha256')
    const download = openSync(archive, 'wx', 0o600)
    let bytes = 0
    let nextProgress = 16 * 1024 * 1024
    try {
      for await (const chunk of response.body) {
        bytes += chunk.byteLength
        if (bytes > 700 * 1024 * 1024) throw new Error('Antigravity archive exceeds the download limit.')
        hash.update(chunk)
        writeAll(download, chunk)
        if (bytes >= nextProgress) { progress(`${Math.round(bytes / 1024 / 1024)} MB`); nextProgress += 16 * 1024 * 1024 }
      }
    } finally { closeSync(download) }
    if (hash.digest('hex') !== release.sha256) throw new Error('Antigravity archive checksum mismatch.')
    progress('Extracting verified archive')
    let total = 0
    let failure: Error | null = null
    const unzip = new Unzip((file) => {
      const dest = resolve(unpacked, file.name)
      if (!dest.startsWith(resolve(unpacked) + sep) || file.name.includes('\\') || file.name.includes(':')) throw new Error('Unsafe archive path.')
      if (file.name.endsWith('/')) { mkdirSync(dest, { recursive: true }); return }
      mkdirSync(resolve(dest, '..'), { recursive: true })
      const fd = openSync(dest, 'wx', process.platform === 'win32' ? 0o600 : 0o755)
      descriptors.add(fd)
      file.ondata = (error, data, final) => {
        if (error) { failure = error; return }
        total += data.byteLength
        if (total > 2 * 1024 ** 3) { failure = new Error('Antigravity archive exceeds the extraction limit.'); return }
        writeAll(fd, data)
        if (final) { closeSync(fd); descriptors.delete(fd) }
      }
      file.start()
    })
    unzip.register(UnzipInflate)
    for await (const chunk of createReadStream(archive)) {
      unzip.push(chunk as Buffer)
      if (failure) throw failure
    }
    unzip.push(new Uint8Array(), true)
    if (failure) throw failure
    if (descriptors.size) throw new Error('Incomplete Antigravity archive.')
    // Versioned directories keep running sessions on their original binaries.
    const destination = join(root, version)
    const previous = join(stage, 'previous')
    let hadPrevious = false
    try { await rename(destination, previous); hadPrevious = true } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    try { await rename(unpacked, destination) } catch (error) {
      if (hadPrevious) await rename(previous, destination)
      throw error
    }
  } finally {
    for (const fd of descriptors) closeSync(fd)
    await rm(stage, { recursive: true, force: true })
  }
}
