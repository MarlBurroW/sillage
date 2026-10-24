import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AntigravityLoginStatusDto, StartAntigravityLogin } from '@sillage/protocol'
import { AcpClient } from '../agents/acp/client.js'
import { CLIENT_INFO } from '../agents/codex/client-info.js'
import { antigravityArgs } from '../agents/antigravity/launch.js'
import { fields } from '../agents/acp/content.js'
import { antigravityEnv, type AntigravityAccountHomes, writeAntigravityCredentials } from './homes.js'
import type { AntigravityAccountStore } from './store.js'

const LOGIN_TIMEOUT = 15 * 60_000
interface Login {
  client: AcpClient
  timer: NodeJS.Timeout
  status: AntigravityLoginStatusDto
  output: string
}

/** Google owns OAuth and token refresh; Sillage relays only the callback for remote browsers. */
export class AntigravityLoginService {
  private readonly pending = new Map<string, Login>()
  private readonly outcomes = new Map<string, AntigravityLoginStatusDto>()
  private readonly closing = new Map<string, Promise<void>>()
  constructor(private readonly homes: AntigravityAccountHomes, private readonly store: AntigravityAccountStore, private readonly binary: () => Promise<string>, private readonly beforeDisconnect: (id: string) => Promise<void> = async () => {}) {}

  status(id: string): AntigravityLoginStatusDto {
    return this.pending.get(id)?.status ?? this.outcomes.get(id) ?? { state: 'idle', verificationUrl: null, error: null }
  }

  async start(id: string, input: StartAntigravityLogin): Promise<AntigravityLoginStatusDto> {
    await this.beforeDisconnect(id)
    await this.cancel(id)
    this.outcomes.delete(id)
    const home = this.homes.ensure(id)
    this.store.setIdentity(id, { authMode: null, email: null, plan: null })
    for (const name of ['acp_token.json', 'acp_business_token.json']) await rm(join(home, 'antigravity-acp', name), { force: true })
    await writeFile(join(home, 'antigravity-acp', 'settings.json'), JSON.stringify({ auth: { type: input.method }, gcp: { project: input.project, location: input.location || 'global' } }), { mode: 0o600 })
    const values: Record<string, string> = {}
    if (input.apiKey && (input.method === 'gemini-api-key' || input.method === 'agent-platform')) values[input.method === 'agent-platform' ? 'GOOGLE_API_KEY' : 'GEMINI_API_KEY'] = input.apiKey
    if (input.method === 'agent-platform') {
      values.GOOGLE_GENAI_USE_VERTEXAI = 'true'
      if (input.project) values.GOOGLE_CLOUD_PROJECT = input.project
      values.GOOGLE_CLOUD_LOCATION = input.location || 'global'
    }
    writeAntigravityCredentials(home, values)
    const client = new AcpClient({
      label: 'antigravity-login', binary: await this.binary(), args: antigravityArgs(), cwd: home,
      env: antigravityEnv(home),
      onStderr: (chunk) => {
        const login = this.pending.get(id)
        if (!login || login.client !== client) return
        login.output = (login.output + chunk).slice(-16_384)
        const match = /https:\/\/accounts\.google\.com\/[^\s\x1b]+/.exec(login.output)
        if (match) login.status = { state: 'pending', verificationUrl: match[0], error: null }
      },
    })
    const login: Login = { client, timer: setTimeout(() => this.fail(id, client, 'Google sign-in timed out.'), LOGIN_TIMEOUT), status: { state: 'pending', verificationUrl: null, error: null }, output: '' }
    this.pending.set(id, login)
    void this.authenticate(id, client, input)
    return login.status
  }

  private async authenticate(id: string, client: AcpClient, input: StartAntigravityLogin): Promise<void> {
    try {
      await client.initialize(CLIENT_INFO)
      const result = await client.request('authenticate', { methodId: input.method }, LOGIN_TIMEOUT)
      if (this.pending.get(id)?.client !== client) return
      const tier = fields(fields(fields(fields(result)._meta).antigravity).tier)
      this.store.setIdentity(id, { authMode: input.method, email: null, plan: typeof tier.name === 'string' ? tier.name : null })
      this.finish(id, client, { state: 'done', verificationUrl: null, error: null })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.fail(id, client, input.apiKey ? message.replaceAll(input.apiKey, '[redacted]') : message)
    }
  }

  /** Restrict the relay to the current login's exact loopback endpoint and state.
   * A submitted URL can never turn this route into a general HTTP proxy. */
  async callback(id: string, value: string): Promise<void> {
    const login = this.pending.get(id)
    const auth = login?.status.verificationUrl
    if (!login || !auth) throw new Error('No Google sign-in is awaiting a callback.')
    const target = validateAntigravityCallback(auth, value)
    const response = await fetch(target, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
    await response.body?.cancel()
    if (response.status >= 400) throw new Error('Google callback was rejected.')
  }

  private finish(id: string, client: AcpClient, status: AntigravityLoginStatusDto): void {
    const login = this.pending.get(id)
    if (!login || login.client !== client) return
    clearTimeout(login.timer)
    this.pending.delete(id)
    const closed = client.closeAndWait().finally(() => {
      if (this.closing.get(id) === closed) this.closing.delete(id)
    })
    this.closing.set(id, closed)
    this.outcomes.set(id, status)
  }
  private fail(id: string, client: AcpClient, error: string): void {
    this.finish(id, client, { state: 'failed', verificationUrl: null, error })
  }
  async cancel(id: string): Promise<void> {
    const login = this.pending.get(id)
    if (login) this.finish(id, login.client, { state: 'idle', verificationUrl: null, error: null })
    // A late native token write must finish before reconnecting or removing a home.
    await this.closing.get(id)
  }
  async logout(id: string): Promise<void> {
    await this.beforeDisconnect(id)
    await this.cancel(id)
    const home = this.homes.ensure(id)
    await logoutAntigravity(await this.binary(), home)
    this.store.setIdentity(id, { authMode: null, email: null, plan: null })
    this.outcomes.delete(id)
  }
  async forget(id: string): Promise<void> {
    await this.beforeDisconnect(id)
    await this.cancel(id)
    this.outcomes.delete(id)
    await rm(this.homes.path(id), { recursive: true, force: true })
  }
  async closeAll(): Promise<void> { for (const id of new Set([...this.pending.keys(), ...this.closing.keys()])) await this.cancel(id) }
}

export function validateAntigravityCallback(authUrl: string, callback: string): URL {
  const auth = new URL(authUrl)
  const expected = new URL(auth.searchParams.get('redirect_uri') || '')
  const target = new URL(callback)
  if (auth.origin !== 'https://accounts.google.com' || expected.protocol !== 'http:' || expected.hostname !== '127.0.0.1' || !expected.port || target.origin !== expected.origin || target.pathname !== expected.pathname || target.username || target.password || target.hash || !auth.searchParams.get('state') || target.searchParams.get('state') !== auth.searchParams.get('state') || (!target.searchParams.has('code') && !target.searchParams.has('error'))) {
    throw new Error('This callback does not belong to the pending Google sign-in.')
  }
  return target
}

/** Use the native logout policy for both account controls and the /logout command. */
export async function logoutAntigravity(binary: string, home: string): Promise<void> {
  const client = new AcpClient({ label: 'antigravity-logout', binary, args: antigravityArgs(), env: antigravityEnv(home), cwd: home, onStderr: () => {} })
  try {
    const init = await client.initialize(CLIENT_INFO)
    if (fields(fields(init.agentCapabilities).auth).logout) await client.request('logout', {})
  } finally { await client.closeAndWait() }
  for (const name of ['acp_token.json', 'acp_business_token.json']) await rm(join(home, 'antigravity-acp', name), { force: true })
  await rm(join(home, 'sillage-credentials.json'), { force: true })
}
