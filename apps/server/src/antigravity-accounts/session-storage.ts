import { backupSqlite } from '@sillage/db'
import { chmod, cp, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

interface Storage { conversations: string; brain: string }

async function copyArtifacts(source: string, destination: string): Promise<void> {
  try {
    await cp(source, destination, { recursive: true, preserveTimestamps: true, filter: async (from, to) => {
      const current = await stat(from)
      if (current.isDirectory()) return true
      const saved = await stat(to).catch(() => null)
      return !saved || saved.size !== current.size || Math.abs(saved.mtimeMs - current.mtimeMs) > 1
    } })
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}
function marker(root: string, id: string): string {
  if (!/^[\w-]+$/.test(id)) throw new Error('Invalid native session ID.')
  return join(root, `${id}.origin.json`)
}
async function storage(home: string): Promise<Storage> {
  const dirs = ['conversations', 'brain'].map((name) => join(home, 'antigravity-acp', name))
  for (const dir of dirs) await mkdir(dir, { recursive: true, mode: 0o700 })
  return { conversations: await realpath(dirs[0]!), brain: await realpath(dirs[1]!) }
}

/** Managed accounts share histories. The CLI-default home needs a consistent SQLite
 * snapshot when switching to/from it; credentials never travel with the session. */
export async function prepareAntigravityResume(home: string, root: string, id: string, originalHome?: string): Promise<void> {
  let source: Storage
  try { source = JSON.parse(await readFile(marker(root, id), 'utf8')) as Storage }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    if (!originalHome) return
    source = await storage(originalHome)
  }
  const target = await storage(home)
  if (source.conversations !== target.conversations) {
    const saved = join(source.conversations, `${id}.db`)
    const size = (await stat(saved)).size
    const dest = join(target.conversations, `${id}.db`)
    const temporary = dest + '.sillage-backup'
    if (size) {
      await backupSqlite(saved, temporary)
    } else await writeFile(temporary, '', { mode: 0o600 })
    await chmod(temporary, 0o600)
    for (const suffix of ['-wal', '-shm']) await rm(dest + suffix, { force: true })
    await rename(temporary, dest)
    try { await cp(join(source.conversations, `${id}.meta`), join(target.conversations, `${id}.meta`)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  if (source.brain === target.brain) return
  await copyArtifacts(join(source.brain, id), join(target.brain, id))
}

export async function rememberAntigravityStorage(home: string, root: string, id: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  await writeFile(marker(root, id), JSON.stringify(await storage(home)), { mode: 0o600 })
}

/** Artifacts outlive account deletion, while native file tools retain a local readable copy. */
export async function persistAntigravityArtifacts(home: string, root: string, id: string): Promise<void> {
  const file = marker(root, id)
  const source = await storage(home)
  const brain = join(root, 'brain')
  await mkdir(brain, { recursive: true, mode: 0o700 })
  await copyArtifacts(join(source.brain, id), join(brain, id))
  await writeFile(file, JSON.stringify({ ...source, brain }), { mode: 0o600 })
}
