import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { linkTo } from '../platform/links.js'
import { agentProcessEnv } from '../agents/process-env.js'

export function userAntigravityHome(): string {
  return process.env.GEMINI_HOME || join(homedir(), '.gemini')
}

function segment(value: string): string {
  if (!/^[\w-]+$/.test(value)) throw new Error('Invalid account or session ID.')
  return value
}

export class AntigravityAccountHomes {
  constructor(private readonly root: string, private readonly ownerOf: (id: string) => string = (id) => id) {}
  path(id: string): string { return join(this.root, segment(id)) }
  sessions(ownerId: string): string { return join(this.root, '.sessions', segment(ownerId)) }
  ensure(id: string): string {
    const home = this.path(id)
    mkdirSync(join(home, 'antigravity-acp'), { recursive: true, mode: 0o700 })
    for (const name of ['config', 'antigravity-cli']) {
      const source = join(userAntigravityHome(), name)
      const link = join(home, name)
      if (existsSync(source) && !existsSync(link)) linkTo(source, link)
    }
    const shared = this.sessions(this.ownerOf(id))
    for (const name of ['conversations', 'brain']) {
      const target = join(shared, name)
      mkdirSync(target, { recursive: true, mode: 0o700 })
      const link = join(home, 'antigravity-acp', name)
      if (!existsSync(link)) linkTo(target, link)
    }
    return home
  }
  connected(id: string): boolean {
    const home = this.path(id)
    return ['acp_token.json', 'acp_business_token.json'].some((name) => existsSync(join(home, 'antigravity-acp', name))) || existsSync(join(home, 'sillage-credentials.json'))
  }
}

/** Explicit account homes must never inherit another account's ambient API keys. */
export function antigravityEnv(home: string, isolated = true): NodeJS.ProcessEnv {
  const env = agentProcessEnv({ GEMINI_HOME: home, AGY_ACP_FORCE_FILE_STORAGE: '1' })
  if (isolated) {
    for (const key of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_APPLICATION_CREDENTIALS']) delete env[key]
  }
  try {
    const saved = JSON.parse(readFileSync(join(home, 'sillage-credentials.json'), 'utf8')) as Record<string, string>
    for (const key of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_CLOUD_LOCATION', 'GOOGLE_GENAI_USE_VERTEXAI']) {
      if (typeof saved[key] === 'string') env[key] = saved[key]
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  return env
}

export function writeAntigravityCredentials(home: string, values: Record<string, string>): void {
  writeFileSync(join(home, 'sillage-credentials.json'), JSON.stringify(values), { mode: 0o600 })
}

/** Keep artifacts and copied skills physically inside the native allowed home.
 * Only SQLite histories are shared; file tools never need to read those paths.
 * Private credential snapshots let the CLI refresh atomically on every platform. */
export function antigravitySessionHome(home: string, id: string, roots: string[]): string {
  const view = join(home, 'sillage-sessions', segment(id))
  mkdirSync(join(home, 'antigravity-acp'), { recursive: true, mode: 0o700 })
  mkdirSync(view, { recursive: true, mode: 0o700 })
  const acp = join(view, 'antigravity-acp')
  if (existsSync(acp) && lstatSync(acp).isSymbolicLink()) rmSync(acp)
  mkdirSync(acp, { recursive: true, mode: 0o700 })
  const histories = join(home, 'antigravity-acp', 'conversations')
  mkdirSync(histories, { recursive: true, mode: 0o700 })
  if (!existsSync(join(acp, 'conversations'))) linkTo(histories, join(acp, 'conversations'))
  const credentials = ['settings.json', 'acp_token.json', 'acp_business_token.json']
  const hash = createHash('sha256')
  for (const name of credentials) {
    const source = join(home, 'antigravity-acp', name)
    hash.update(name)
    if (existsSync(source)) hash.update(readFileSync(source))
  }
  const revision = hash.digest('hex')
  const revisionFile = join(view, '.auth-revision')
  if (!existsSync(revisionFile) || readFileSync(revisionFile, 'utf8') !== revision) {
    for (const name of credentials) {
      const source = join(home, 'antigravity-acp', name), dest = join(acp, name)
      if (existsSync(source)) { cpSync(source, dest); chmodSync(dest, 0o600) }
      else rmSync(dest, { force: true })
    }
    writeFileSync(revisionFile, revision, { mode: 0o600 })
  }
  const config = join(view, 'config')
  mkdirSync(config, { recursive: true })
  // Preserve native hooks/MCP configuration without copying credentials into the view.
  if (existsSync(join(home, 'config'))) for (const entry of readdirSync(join(home, 'config'))) {
    if (entry === 'skills') continue
    const link = join(config, entry)
    if (!existsSync(link)) linkTo(join(home, 'config', entry), link)
  }
  for (const [skills, sources] of [
    [join(config, 'skills'), [join(home, 'config', 'skills'), ...roots.map((root) => join(root, 'skills'))]],
    [join(view, 'antigravity-cli', 'skills'), [join(home, 'antigravity-cli', 'skills')]],
  ] as [string, string[]][]) {
    rmSync(skills, { recursive: true, force: true })
    mkdirSync(skills, { recursive: true })
    for (const source of sources) {
      if (!existsSync(source)) continue
      for (const name of readdirSync(source)) {
        const dest = join(skills, name)
        rmSync(dest, { recursive: true, force: true })
        cpSync(join(source, name), dest, { recursive: true, dereference: true })
      }
    }
  }
  return view
}
