import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { conversationHandoffs, conversations, permissionRequests, projects, scheduledTasks, type ConversationRow, type Db } from '@sillage/db'
import {
  disabledSillageTools,
  parseAgentConfig,
  type ConversationStatus,
  type SillageEvent,
} from '@sillage/protocol'
import type { BrowserManager } from '../browser/manager.js'
import { agentToolsFor, familyTableForMcp, sessionFamilies } from '../agents/agent-tools.js'
import { detach } from '../detach.js'
import { personalMemoryDir, readPersonalMemory } from '../memory/personal.js'
import { processOrigins } from '../services/origins.js'
import type { AgentRegistry } from '../agents/registry.js'
import { resolveBinary } from '../agents/cli-binary.js'
import { unattendedRetryEnv } from '../agents/claude/unattended-retries.js'
import { builtinMcpEnabled, builtinMcpServer } from '../agents/mcp-builtin.js'
import { sessionReferenceContext } from '../conversations/references.js'
import { MEDIA_DIR_ENV, conversationMediaRoot, ensureConversationMediaDir } from '../conversations/media.js'
import { publicUrlOf } from '../settings/app-settings.js'
import { liveSessionContext, projectOverview } from '../agents/overview.js'
import { instructionsAppendix, resolveInstructionsMode } from '../instructions/store.js'
import { ensureProjectMemory, memoryAppendixForCodex } from '../memory/store.js'
import { resolveMcpServers } from '../agents/mcp-registry.js'
import type { SecretStore } from '../secrets/store.js'
import { userAntigravityHome } from '../antigravity-accounts/homes.js'
import { logoutAntigravity } from '../antigravity-accounts/login.js'
import type { RunnerContext } from '../agents/types.js'
import type { Config } from '../config.js'
import type { EventLog } from '../events/event-log.js'
import { SkillLibraryLayout } from '../skill-library/layout.js'
import { resolveConversationCwd } from '../workspace.js'
import { linkedWorktreePaths } from '../worktrees/linked.js'
import type { TurnUsageRecorder } from '../consumption/recorder.js'
import type { SessionAccounts } from './session-accounts.js'

/**
 * Ties a runner's context to that runner rather than to its conversation. A stopped runner keeps
 * unwinding for a moment (Claude's stream ends after `stop`, then journals `session.ended` and
 * sets `idle`); when a successor already serves the conversation, those late calls would close
 * its turn and mark it idle mid-work. Calls are dropped once another lease holds the
 * conversation. Without a successor they still land: they are what closes the stopped turn.
 */
export interface RunnerLease {
  readonly conversationId: string
}

/** What a runner's context reports back to the session manager, which owns the live state. */
export interface RunnerContextHooks {
  /** Set once the daemon is going away (`stopAll`). */
  closing(): boolean
  /** Lease of the runner currently serving the conversation, if any. */
  liveLease(conversationId: string): RunnerLease | undefined
  setStatus(conversationId: string, status: ConversationStatus): void
  setActivity(conversationId: string, patch: { background?: number; loops?: number }): void
  notify(conversationId: string, event: SillageEvent): Promise<void>
  markEdited(conversationId: string, path: string): void
  closeCheckpoint(conversationId: string): void
  adoptSuggestedTitle(conversationId: string): Promise<void>
  stopAntigravityAccount(accountId: string, exceptId?: string): Promise<void>
}

/** Builds the `RunnerContext` each CLI runner starts with: environment, instructions, MCP servers, and the callbacks through which its events reach the journal and the conversation row. */
export class RunnerContextFactory {
  /** Agent browsers, wired after construction like other optional services; absent in tests. */
  browsers: BrowserManager | null = null

  constructor(
    private readonly db: Db,
    private readonly log: EventLog,
    private readonly config: Config,
    private readonly registry: AgentRegistry,
    private readonly secrets: SecretStore,
    private readonly accounts: SessionAccounts,
    /** Absent in tests that do not look at consumption. */
    private readonly usage: TurnUsageRecorder | null,
    private readonly hooks: RunnerContextHooks,
  ) {}

  /** Maximum duration of a scheduled task, or null once the task is gone. */
  private scheduleDuration(scheduleId: string): number | null {
    return this.db
      .select({ minutes: scheduledTasks.maxDurationMinutes })
      .from(scheduledTasks)
      .where(eq(scheduledTasks.id, scheduleId))
      .get()?.minutes ?? null
  }

  build(conversation: ConversationRow, lease?: RunnerLease): RunnerContext {
    const memoryDirOrNull = (agent: ConversationRow['agent'], dir: string | null, sillageMcp: boolean) =>
      agent !== 'claude' && dir ? memoryAppendixForCodex(dir, sillageMcp, 'project', true, agent !== 'antigravity') : null
    const conversationId = conversation.id
    const adapter = this.registry.adapter(conversation.agent)
    const config = parseAgentConfig(conversation.config)
    const cwd = resolveConversationCwd(this.db, conversation)
    // At every launch, before the CLI starts: each one is let into it from the outset.
    const mediaDir = ensureConversationMediaDir(conversationMediaRoot(this.config.paths.data), conversationId)
    // One context per launch: the moving overview goes with its first message only.
    let liveSent = false
    // History imports run without a lease: nothing to be superseded by.
    const superseded = () => {
      if (!lease) return false
      // Shutdown has journaled each turn's end itself: a runner unwinding after `stop` must not
      // mark its conversation idle, which hid it from restart recovery and from schedules.
      if (this.hooks.closing()) return true
      const live = this.hooks.liveLease(conversationId)
      return live !== undefined && live !== lease
    }
    // Reread on every call rather than fix here: modes may change between runner
    // starts and depend on directory contents for legacy projects.
    const instructions = () => {
      if (conversation.projectId === null) return null
      const project = this.db
        .select({ instructionsMode: projects.instructionsMode, workspacePath: projects.workspacePath, memoryMode: projects.memoryMode })
        .from(projects)
        .where(eq(projects.id, conversation.projectId))
        .get()
      return project ? { ...project, mode: resolveInstructionsMode(project) } : null
    }
    // Create and initially import prior Claude workspace memory:
    // without import, moving directories would erase learning. Null in native
    // mode: each CLI retains its own memory and Sillage injects nothing.
    // Tool families, read once per launch (switches apply at the next CLI start). `families` is
    // null for a personal discussion, which keeps every built-in tool; `toolFamilies` also covers
    // it for the browser, which follows the instance default there.
    const toolFamilies = agentToolsFor(this.db, this.config, conversation.projectId)
    const families = sessionFamilies(this.db, conversation, toolFamilies)
    const memoryDir = () => {
      // Benchmark runs share nothing: a variant that read what the previous one wrote would
      // not be measured on the same prompt.
      if (conversation.benchmarkId) return null
      if (conversation.projectId === null) return personalMemoryDir(this.config.paths.memory, conversation.userId)
      const project = instructions()
      if (project?.memoryMode === 'native') return null
      return ensureProjectMemory(this.config.paths.memory, conversation.projectId, project?.workspacePath ?? cwd)
    }

    return {
      conversationId,
      cwd,
      config,
      // Resolve once here rather than in each runner: Codex passes this to `spawn`,
      // which searches PATH but ignores Sillage's managed installation
      // prefix. Bare runner names would miss
      // interface-installed CLIs.
      binary: resolveBinary(adapter.binary, adapter.cli.managedDir) ?? adapter.binary,
      attachmentsRoot: this.config.paths.attachments,
      mediaDir,
      accountSignedOut: async () => {
        if (config.agent !== 'antigravity') return
        if (config.account) await this.hooks.stopAntigravityAccount(config.account, conversationId)
        const home = this.accounts.antigravityHome(conversation.userId, config.account) ?? userAntigravityHome()
        await logoutAntigravity(await adapter.cli.executable(), home)
        if (config.account) this.accounts.antigravityAccounts.store.setIdentity(config.account, { authMode: null, email: null, plan: null })
      },
      processEnv: {
        ...processOrigins(this.config.paths.data).environment(conversation.projectId, conversationId, conversation.projectId === null ? conversation.userId : undefined),
        [MEDIA_DIR_ENV]: mediaDir,
        // Tells Claude Code a local host scheduled it rather than a person opening it
        // (probed 2.1.291). Other CLIs ignore this.
        ...(conversation.scheduleId && conversation.agent === 'claude'
          ? { CLAUDE_CODE_HOST_SCHEDULED_RUN: '1' }
          : {}),
        // Nobody resends an unattended run that an API overload failed: let Claude wait it out.
        ...(conversation.agent === 'claude' ? unattendedRetryEnv({
          scheduleId: conversation.scheduleId,
          createdByTokenId: conversation.createdByTokenId,
          maxDurationMinutes: conversation.scheduleId ? this.scheduleDuration(conversation.scheduleId) : null,
        }) : {}),
        ...this.accounts.accountEnv(conversation, config),
      },
      // Sillage's server goes last: order resolves duplicate tool names,
      // and user-declared servers must win
      // over platform-added servers.
      resolveMcpServers: (current) => {
        const resolved = resolveMcpServers(this.db, this.secrets, current.mcpServers, conversation.projectId)
        const builtin = builtinMcpServer({
          enabled: this.config.mcp.sillageServer,
          config: current,
          databasePath: this.config.paths.database,
          projectId: conversation.projectId,
          conversationId,
          memoryDir: memoryDir(),
          memoryRoot: this.config.paths.memory,
          disabledTools: families ? disabledSillageTools(families) : [],
          familyTable: families ? familyTableForMcp() : undefined,
        })
        // Agent browser (tool family `browser`): only when the family is on for this project
        // and the tools are installed. Benchmarks get the same tools for every variant or none:
        // they follow the instance default like personal discussions.
        // `strictMcp` promises only declared servers, like the built-in one below.
        const strict = current.agent === 'claude' && current.strictMcp
        const browser = this.browsers && !strict && toolFamilies.browser
          ? this.browsers.mcpServerFor(conversationId)
          : null
        const servers = [...resolved.servers, ...(browser ? [browser] : []), ...(builtin ? [builtin] : [])]
        return { ...resolved, servers }
      },

      // The first message of each launch also carries the moving overview (`liveSessionContext`):
      // a resumed Claude or Grok keeps its first system prompt, and opencode's cache needs a stable one.
      sessionReferenceContext: (text, current) => {
        const sillageMcp = builtinMcpEnabled(this.config.mcp.sillageServer, current)
        const live = liveSent || conversation.benchmarkId ? null : liveSessionContext(this.db, {
          projectId: conversation.projectId,
          conversationId,
          sillageMcp,
          activity: this.config.mcp.sillageServer && current.sillageMcp,
          families,
        })
        liveSent = true
        const references = sessionReferenceContext(
          this.db, conversation.projectId, text, publicUrlOf(this.db, this.config), sillageMcp && (families?.history !== false), conversation.userId,
        )
        return [live, references].filter((part) => part !== null).join('\n\n') || null
      },

      // Follow MCP server switches except `strictMcp`, which excludes undeclared
      // servers and therefore concerns tools rather than
      // Sillage's descriptions of platform state.
      //
      // SILLAGE.md bypasses these switches: user instructions are not optional
      // platform additions.
      projectOverview: (current) => {
        const sillageMcp = builtinMcpEnabled(this.config.mcp.sillageServer, current)
        // Source-conversation handoff context uses the same channel as SILLAGE.md,
        // outside all switches: this is the conversation's history,
        // not platform additions. Reread at every start because CLIs lose it
        // on resume, like instructions.
        const handoff = this.db
          .select({ text: conversationHandoffs.text })
          .from(conversationHandoffs)
          .where(eq(conversationHandoffs.conversationId, conversationId))
          .get()
        // A benchmark run gets the prompt and nothing else: platform descriptions and memory
        // would add context one variant might use and another ignore.
        if (conversation.benchmarkId) return handoff?.text ?? null
        const parts = [
          handoff?.text ?? null,
          conversation.projectId === null ? `This is a personal Sillage discussion with its own persistent working directory. Keep new work and files here unless the user chooses another location. No project owns this discussion: never borrow Sandbox or another unrelated project just because a tool requires one. Model discovery with list_models needs no project. When an idea becomes a project or needs delegated project sessions, use continue_in_project to create a dedicated project with a self-contained brief (goal, decisions, relevant files, uncertainties and next steps) and explicitly selected files. If the user wants the work to continue now, supply prompt to start that linked session; otherwise its brief remains visible while it waits. Reuse the returned session with message_session rather than creating another continuation. The original files remain here, including large media. You may inspect, steer, interrupt and resume this account's project sessions using read_session, steer_session, interrupt_session and message_session. Use existing projects only when the user targets them. Use native file tools elsewhere only as requested and permitted by the CLI. Cite sessions as session:<id>.` : null,
          instructionsAppendix(this.db, {
            projectId: conversation.projectId,
            mode: instructions()?.mode ?? 'repo',
            sillageMcp,
            instructionsTools: families?.instructions !== false,
            mediaDir,
          }),
          // Claude loads its memory index itself; Codex and opencode have only
          // the information supplied explicitly. Nothing in native mode.
          conversation.projectId === null
            ? `${memoryAppendixForCodex(memoryDir()!, sillageMcp, 'personal', conversation.agent !== 'claude', conversation.agent !== 'antigravity') ?? ''}\n\nRetain durable preferences and decisions automatically, keep notes concise, and mention meaningful memory updates to the user. Memory belongs to this account and is shared across personal discussions. Never copy it into projects automatically.`
            : memoryDirOrNull(conversation.agent, memoryDir(), sillageMcp),
          this.config.mcp.sillageServer && current.sillageMcp && conversation.projectId
            ? projectOverview(this.db, {
                projectId: conversation.projectId,
                conversationId,
                sillageMcp,
                families,
              })
            : null,
        ].filter((part) => part !== null)
        return parts.length > 0 ? parts.join('\n\n') : null
      },
      memoryDir,
      maskedInstructionRoots: () => {
        const current = instructions()
        return current?.mode === 'sillage' ? [current.workspacePath, cwd] : []
      },
      skillRoots: (current) =>
        this.config.skills.library && current.skillLibrary
          ? new SkillLibraryLayout(this.config.paths.skillLibrary).rootsFor(conversation.projectId)
          : [],
      workTrees: () => conversation.projectId ? linkedWorktreePaths(this.db, conversationId, conversation.projectId) : [],
      resumeSessionId: conversation.agentSessionId,

      emit: (event: SillageEvent, raw?: unknown, rawFormat?: string) => {
        if (superseded()) return
        const entry = this.log.append(conversationId, event, raw, rawFormat ?? adapter.rawFormat)
        this.usage?.observe(conversationId, entry, raw)
        if (event.type === 'turn.completed' && conversation.projectId === null && !conversation.benchmarkId) {
          void readPersonalMemory(this.db, personalMemoryDir(this.config.paths.memory, conversation.userId), conversation.userId, conversationId).catch(err => console.warn('Personal memory refresh failed', err))
        }
        detach(this.hooks.notify(conversationId, event), 'notification of an absent user')
        // Journals suffice for open conversations folding events; conversation lists and
        // other processes have only conversation rows to determine
        // that work continues elsewhere.
        if (event.type === 'background.updated') {
          this.hooks.setActivity(conversationId, { background: event.tasks.length })
        }
        if (event.type === 'loops.updated') {
          this.hooks.setActivity(conversationId, { loops: event.loops.length })
        }
        // CLIs reemit initialization on live model changes:
        // retain the latest value for reads after sessions cool.
        if (event.type === 'session.started') {
          this.db
            .update(conversations)
            .set({ model: event.model })
            .where(eq(conversations.id, conversationId))
            .run()
        }
        // Not every usage update includes context: without this guard, the first missing
        // value would erase the only known figure.
        if (event.type === 'usage.updated' && event.context) {
          this.db
            .update(conversations)
            .set({
              contextUsedTokens: event.context.usedTokens,
              contextMaxTokens: event.context.maxTokens,
            })
            .where(eq(conversations.id, conversationId))
            .run()
        }
        if (event.type === 'file.edited') {
          this.hooks.markEdited(conversationId, event.path)
        }
        // Turn completion and snapshot completion are separate milestones: start capture
        // here without awaiting; status becomes idle independently.
        if (event.type === 'turn.completed' || event.type === 'session.ended') {
          this.hooks.closeCheckpoint(conversationId)
        }
        if (event.type === 'usage.consumed') {
          this.db
            .update(conversations)
            .set({
              costUsd: sql`${conversations.costUsd} + ${event.costUsd}`,
              inputTokens: sql`${conversations.inputTokens} + ${event.inputTokens}`,
              outputTokens: sql`${conversations.outputTokens} + ${event.outputTokens}`,
            })
            .where(eq(conversations.id, conversationId))
            .run()
        }
        if (event.type === 'turn.completed') {
          this.log.refreshTurnCount(conversationId)
          // CLIs summarize sessions only after turns finish,
          // the first moment useful titles exist.
          detach(this.hooks.adoptSuggestedTitle(conversationId), 'title adoption')
          // SQL increments rather than memory additions: `conversation` was read at runner
          // creation, so reusing it would overwrite previous turns.
          this.db
            .update(conversations)
            .set({
              costUsd: sql`${conversations.costUsd} + ${event.costUsd}`,
              inputTokens: sql`${conversations.inputTokens} + ${event.inputTokens}`,
              outputTokens: sql`${conversations.outputTokens} + ${event.outputTokens}`,
            })
            .where(eq(conversations.id, conversationId))
            .run()
        }
      },

      setStatus: (status) => {
        if (!superseded()) this.hooks.setStatus(conversationId, status)
      },

      setAgentSessionId: (sessionId) => {
        if (superseded()) return
        this.db
          .update(conversations)
          .set({ agentSessionId: sessionId })
          .where(eq(conversations.id, conversationId))
          .run()
      },

      updateConfig: (config) => {
        if (superseded()) return
        this.db
          .update(conversations)
          .set({ config: JSON.stringify(config) })
          .where(eq(conversations.id, conversationId))
          .run()
      },

      openPermissionRequest: (toolName, input) => {
        const id = randomUUID()
        const current = this.db
          .select({ lastSeq: conversations.lastSeq })
          .from(conversations)
          .where(eq(conversations.id, conversationId))
          .get()

        this.db
          .insert(permissionRequests)
          .values({
            id,
            conversationId,
            seq: (current?.lastSeq ?? 0) + 1,
            toolName,
            input: JSON.stringify(input),
            status: 'pending',
            decisionScope: null,
            decidedBy: null,
            createdAt: Date.now(),
            decidedAt: null,
          })
          .run()
        return id
      },

      closePermissionRequest: (requestId, decision) => {
        this.db
          .update(permissionRequests)
          .set({
            status: decision.decision === 'allowed' ? 'allowed' : 'denied',
            decisionScope: decision.scope,
            decidedBy: decision.decidedBy,
            decidedAt: Date.now(),
          })
          .where(eq(permissionRequests.id, requestId))
          .run()
      },
    }
  }
}
