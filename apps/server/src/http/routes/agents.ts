import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { agentKindSchema, compareCliVersions, PREFERRED_CLI_RELEASES, type ProjectCommandsDto } from '@sillage/protocol'
import type { CliDescription } from '../../agents/cli-binary.js'
import type { CliInstaller } from '../../agents/cli-install.js'
import type { AgentAdapter, AgentRegistry } from '../../agents/registry.js'
import { claudeCredential } from '../../agents/claude/credential.js'
import type { ClaudeAccountStore } from '../../claude-accounts/store.js'
import type { CodexAccountHomes } from '../../codex-accounts/homes.js'
import type { CodexAccountStore } from '../../codex-accounts/store.js'
import type { GrokAccountHomes } from '../../grok-accounts/homes.js'
import type { AntigravityAccountHomes } from '../../antigravity-accounts/homes.js'
import type { GrokAccountStore } from '../../grok-accounts/store.js'
import type { AntigravityAccountStore } from '../../antigravity-accounts/store.js'
import { projectCwd } from '../../workspace.js'
import type { AppContext } from '../context.js'
import { HttpError } from '../errors.js'
import { requireAdmin, requireUser } from '../require-user.js'

const commandsQuerySchema = z.object({
  agent: agentKindSchema,
  worktreeId: z.string().optional(),
  account: z.string().optional(),
  refresh: z.string().optional(),
})

/** Failed CLI probes return 502, never an empty list: hardcoded catalogs or bare empty arrays would misrepresent availability. Missing, unauthenticated and slow CLIs all fail consistently. */
function cliUnavailable(
  adapter: AgentAdapter,
  code: string,
  message: string,
  err: unknown,
): HttpError {
  return new HttpError(502, code, message, {
    label: adapter.label,
    error: err instanceof Error ? err.message : String(err),
  })
}

export function registerAgentRoutes(
  app: FastifyInstance,
  ctx: AppContext,
  registry: AgentRegistry,
  installer: CliInstaller,
  claudeAccounts: ClaudeAccountStore,
  codexAccounts: { store: CodexAccountStore; homes: CodexAccountHomes },
  grokAccounts: { store: GrokAccountStore; homes: GrokAccountHomes },
  antigravityAccounts: { store: AntigravityAccountStore; homes: AntigravityAccountHomes },
): void {
  /** CLI names come from requests: unknown names return 404 rather than silently defaulting. */
  /** Resolves additional account references with their owner: browser-provided IDs belonging to someone else must reveal neither tokens nor usage. Null for unknown accounts or CLIs without accounts. */
  const accountCredential = (agent: string, userId: string, accountId: string): string | null => {
    if (agent === 'claude') {
      // Kind and token together: the catalog probes under either, the usage probe only under tokens.
      const resolved = claudeAccounts.resolveToken(userId, accountId)
      return resolved ? claudeCredential(resolved.kind, resolved.token) : null
    }
    if (agent === 'codex') {
      const account = codexAccounts.store.find(userId, accountId)
      return account && account.status === 'ready' ? codexAccounts.homes.ensure(accountId) : null
    }
    if (agent === 'grok') {
      const account = grokAccounts.store.find(userId, accountId)
      return account && account.status === 'ready' ? grokAccounts.homes.ensure(accountId) : null
    }
    if (agent === 'antigravity') {
      const account = antigravityAccounts.store.find(userId, accountId)
      return account && account.status === 'ready' ? antigravityAccounts.homes.ensure(accountId) : null
    }
    return null
  }
  const resolveAdapter = (agent: string): AgentAdapter => {
    const adapter = registry.find(agent)
    if (!adapter) throw new HttpError(404, 'unknown_agent', 'Unknown CLI: {agent}.', { agent })
    return adapter
  }
  const descriptions = new Map<string, CliDescription>()
  const describe = async (adapter: AgentAdapter, force = false): Promise<CliDescription> => {
    // Polling progress must not execute the binary while npm is replacing it, especially on Windows.
    const previous = descriptions.get(adapter.kind)
    if (previous && installer.state(adapter.kind).status === 'running') return previous
    const current = await adapter.cli.describe(force)
    descriptions.set(adapter.kind, current)
    return current
  }
  const paramsAgent = (params: unknown) => (params as { agent: string }).agent

  /** CLI presence and versions across agents. Sillage no longer bundles binaries: system-installed CLIs require the screen to explain which is missing and why rather than offer agents the server cannot launch. `?refresh=1` forces a probe after an external installation. */
  app.get('/api/agents', async (request) => {
    requireUser(request)
    const force = (request.query as { refresh?: string }).refresh === '1'

    // Run concurrently: missing CLIs require PATH resolution, installed CLIs require
    // process launches, and serializing them would delay
    // the screen unnecessarily.
    const agents = await Promise.all(
      registry.all().map(async (adapter) => ({
        ...(await describe(adapter, force)),
        preferredVersion: PREFERRED_CLI_RELEASES[adapter.kind].version,
        install: installer.state(adapter.kind),
      })),
    )
    return { agents }
  })

  /** Installs the recommended CLI version in Sillage's managed prefix. Returns before completion: packages weigh hundreds of megabytes, and waiting inside the request would depend on proxy patience. Progress is available through `GET /api/agents`. */
  app.post('/api/agents/:agent/install', async (request, reply) => {
    requireAdmin(request)
    const adapter = resolveAdapter(paramsAgent(request.params))
    if (!adapter.cli.installable) {
      throw new HttpError(409, 'cli_install_unmanaged', 'This CLI is disabled or uses a custom executable. Update it outside Sillage.')
    }
    const installed = await describe(adapter)
    if (installed.version && (compareCliVersions(installed.version, PREFERRED_CLI_RELEASES[adapter.kind].version) ?? 0) > 0) {
      throw new HttpError(409, 'cli_newer_version', 'A newer version is already installed. Sillage will not downgrade it.')
    }

    if (!installer.start(adapter.kind)) {
      throw new HttpError(
        409,
        'install_in_progress',
        'An installation of {label} is already in progress.',
        { label: adapter.label },
      )
    }
    return reply.status(202).send(installer.state(adapter.kind))
  })

  app.delete('/api/agents/:agent/install', async (request, reply) => {
    requireAdmin(request)
    const adapter = resolveAdapter(paramsAgent(request.params))
    if (!installer.cancel(adapter.kind)) {
      throw new HttpError(409, 'cli_install_not_queued', 'Only a waiting installation can be cancelled.')
    }
    return reply.status(204).send()
  })

  /** Account usage, read on demand rather than pushed: each read starts a CLI process, and values matter only when viewed. `?refresh=1` bypasses the cache; `?account=` reads an additional user account using its token. */
  app.get('/api/agents/:agent/usage', async (request) => {
    const user = requireUser(request)
    const adapter = resolveAdapter(paramsAgent(request.params))
    const { refresh, account } = request.query as { refresh?: string; account?: string }
    const force = refresh === '1'

    try {
      if (!account) return await adapter.usage(force)
      const credential = accountCredential(adapter.kind, user.id, account)
      if (credential === null || !adapter.usageForAccount) {
        throw new HttpError(404, 'agent_account_not_found', 'Unknown account for this CLI.')
      }
      return await adapter.usageForAccount(account, credential, force)
    } catch (err) {
      if (err instanceof HttpError) throw err
      throw cliUnavailable(
        adapter,
        'usage_unavailable',
        'Could not read usage from {label}: {error}.',
        err,
      )
    }
  })

  /** Model catalog of the CLI's own login, or of an additional account with `?account=` because plans decide the list. `?refresh=1` bypasses the cache like `/usage`, for a list that changed after a login. */
  app.get('/api/agents/:agent/models', async (request) => {
    const user = requireUser(request)
    const adapter = resolveAdapter(paramsAgent(request.params))
    const { account, refresh } = request.query as { account?: string; refresh?: string }
    const credential = account ? accountCredential(adapter.kind, user.id, account) : undefined
    if (account && credential == null) throw new HttpError(404, 'agent_account_not_found', 'Unknown account for this CLI.')

    try {
      return await adapter.models(credential ?? undefined, refresh === '1')
    } catch (err) {
      throw cliUnavailable(
        adapter,
        'model_list_unavailable',
        'Could not read models from {label}: {error}.',
        err,
      )
    }
  })

  /** Slash commands offered in conversation drafts. Conversations receive their list from the runner on the first turn; before then only a directory and selected CLI exist. Project-scoped like `/files`, using the same directory because project commands live in the tree. `?refresh=1` bypasses the cache like `/usage`. */
  app.get('/api/projects/:id/commands', async (request): Promise<ProjectCommandsDto> => {
    const user = requireUser(request)
    const { id } = request.params as { id: string }
    const { agent, worktreeId, refresh, account } = commandsQuerySchema.parse(request.query)
    const cwd = projectCwd(ctx.db, id, user.id, worktreeId)
    const adapter = resolveAdapter(agent)

    const credential = account ? accountCredential(agent, user.id, account) : undefined
    if (account && credential == null) throw new HttpError(404, 'agent_account_not_found', 'Unknown account for this CLI.')
    try {
      return await adapter.commands(cwd, refresh === '1', credential ?? undefined)
    } catch (err) {
      throw cliUnavailable(
        adapter,
        'command_list_unavailable',
        'Could not read commands from {label}: {error}.',
        err,
      )
    }
  })
}
