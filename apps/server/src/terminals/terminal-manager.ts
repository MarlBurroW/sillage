import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawn, type IPty } from 'node-pty'
import { MAX_TERMINALS_PER_PROJECT, type TerminalDto } from '@sillage/protocol'
import type { Config } from '../config.js'
import { commandShell, interactiveShell } from '../platform/shells.js'
import { processOrigins } from '../services/origins.js'

/** Project-attached terminals. A pty lives in a directory rather than a conversation; conversation indexing hid servers launched from archived sessions. Sessions only supply default directories (worktrees) at opening. Deliberately outside journals: shell output is large, not conversation content, and database persistence would add unused weight. Retain just enough buffer to restore screens on return. Processes intentionally do not survive daemon restarts, which would require external hosts such as tmux. Persist metadata and final screens so entries return as interrupted, readable and restartable. */

/** Screen restoration buffer; larger buffers would reconstruct history rather than screens. */
const REPLAY_BYTES = 128 * 1024

/** Persist changed screens at this interval. */
const FLUSH_INTERVAL_MS = 30 * 1000

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

export interface TerminalSubscriber {
  onOutput(data: string): void
  onExit(code: number): void
}

interface ManagedTerminal {
  id: string
  projectId: string
  title: string
  /** Null for entries restored after restarts because their processes are gone. */
  pty: IPty | null
  cwd: string
  /** Recent output for repainting screens after reconnecting. */
  replay: string
  /** Disk screen lags behind memory. */
  replayDirty: boolean
  subscribers: Set<TerminalSubscriber>
  idleTimer: NodeJS.Timeout | null
  cols: number
  rows: number
  createdAt: number
  /** Process exited; retain its tab and final screen. */
  exited: boolean
  /** Process ended through daemon restart rather than `exit`. */
  interrupted: boolean
  /** Project action run by this terminal; null for shells. */
  actionId: string | null
  exitCode: number | null
}

interface PersistedTerminal {
  id: string
  projectId: string
  title: string
  cwd: string
  createdAt: number
  actionId?: string | null
}

/** Command to run instead of an interactive shell. */
export interface TerminalCommand {
  command: string
  title: string
  actionId: string | null
  /** Execution-specific variables overriding daemon environment and origin. */
  env?: Record<string, string>
}

/** Shell exited or never started: distinct rejections for display. */
export class TerminalError extends Error {
  constructor(
    readonly code: 'too_many_terminals' | 'terminal_not_found',
    message: string,
  ) {
    super(message)
    this.name = 'TerminalError'
  }
}

export class TerminalManager {
  private readonly terminals = new Map<string, ManagedTerminal>()
  private readonly storeDir: string
  private readonly flushTimer: NodeJS.Timeout

  constructor(private readonly config: Config) {
    this.storeDir = join(config.paths.data, 'terminals')
    mkdirSync(this.storeDir, { recursive: true })
    this.restore()

    this.flushTimer = setInterval(() => this.flushDirty(), FLUSH_INTERVAL_MS)
    this.flushTimer.unref()
  }

  private touch(terminalId: string): void {
    const managed = this.terminals.get(terminalId)
    if (!managed) return

    if (managed.idleTimer) clearTimeout(managed.idleTimer)
    managed.idleTimer = setTimeout(
      () => this.reapIfIdle(terminalId),
      this.config.limits.ptyIdleTimeoutMin * 60 * 1000,
    )
    // Idle terminals alone must not keep processes alive.
    managed.idleTimer.unref()
  }

  /** Inactivity deadlines reap only shells at prompts. Shells running dev servers or long builds are working even without user input; that work is why they were opened. Extend deadlines while child processes exist. */
  private reapIfIdle(terminalId: string): void {
    const managed = this.terminals.get(terminalId)
    if (!managed || managed.exited || !managed.pty) return

    // Action processes are commands themselves (`sh -c` often replaces the shell),
    // so no children does not imply inactivity.
    if (managed.actionId || hasChildProcess(managed.pty.pid)) {
      this.touch(terminalId)
      return
    }
    this.close(terminalId)
  }

  private of(projectId: string): ManagedTerminal[] {
    return [...this.terminals.values()]
      .filter((managed) => managed.projectId === projectId)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  list(projectId: string): TerminalDto[] {
    return this.of(projectId).map(toDto)
  }

  /** Latest terminal opened for this action, alive or not. */
  latestForAction(projectId: string, actionId: string): TerminalDto | null {
    const found = this.of(projectId).filter((managed) => managed.actionId === actionId).at(-1)
    return found ? toDto(found) : null
  }

  /** Live project shells for project-list activity indicators. */
  aliveCount(projectId: string): number {
    return [...this.terminals.values()].filter(
      (managed) => managed.projectId === projectId && !managed.exited,
    ).length
  }

  /** Opens shells or executes commands when `run` is supplied. Commands use `shell -lc` rather than typing into interactive shells: terminals exit with commands and expose exit codes; login shells load the same PATH as manual shells. */
  open(projectId: string, cwd: string, run?: TerminalCommand): TerminalDto {
    const existing = this.of(projectId)
    if (run?.actionId) {
      // Completed runs of the same action yield their slot: repeated launches must not
      // exhaust terminal limits with stale screens.
      for (const previous of existing) {
        if (previous.actionId === run.actionId && previous.exited) this.close(previous.id)
      }
    }
    const remaining = this.of(projectId)
    if (remaining.length >= MAX_TERMINALS_PER_PROJECT) {
      throw new TerminalError(
        'too_many_terminals',
        `Maximum ${MAX_TERMINALS_PER_PROJECT} terminals per project.`,
      )
    }

    const id = randomUUID()
    // Commands use POSIX-compatible shells; empty terminals use the user's shell
    // (see `platform/shells.ts`).
    const shell = run ? commandShell() : interactiveShell()
    const pty = spawn(shell.command, run ? [...shell.args, run.command] : shell.args, {
      name: 'xterm-256color',
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd,
      env: {
        ...process.env,
        ...processOrigins(this.config.paths.data).environment(projectId, null),
        ...run?.env,
        TERM: 'xterm-256color',
      },
    })

    const managed: ManagedTerminal = {
      id,
      projectId,
      // Number by open entries rather than counters: closing the first and reopening
      // must not produce duplicate 'shell 2' labels.
      title: run?.title ?? nextTitle(remaining),
      pty,
      cwd,
      // Show commands first in gray so screens retain launch information after
      // output scrolls away.
      replay: run ? `\x1b[2m$ ${run.command.replace(/\n/g, '\r\n  ')}\x1b[0m\r\n` : '',
      replayDirty: false,
      subscribers: new Set(),
      idleTimer: null,
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      createdAt: Date.now(),
      exited: false,
      interrupted: false,
      actionId: run?.actionId ?? null,
      exitCode: null,
    }
    this.terminals.set(id, managed)
    this.persistMeta(managed)

    pty.onData((data) => {
      managed.replay = (managed.replay + data).slice(-REPLAY_BYTES)
      managed.replayDirty = true
      for (const subscriber of managed.subscribers) subscriber.onOutput(data)
    })

    pty.onExit(({ exitCode }) => {
      // Entries outlive processes with their final screen: accidental `exit` or failed
      // commands must not erase output users wanted to read.
      managed.exited = true
      if (managed.idleTimer) clearTimeout(managed.idleTimer)
      managed.idleTimer = null
      if (run) {
        managed.exitCode = exitCode
        const footer = `\r\n\x1b[2m[${exitCode === 0 ? 'exit 0' : `exit ${exitCode}`}]\x1b[0m\r\n`
        managed.replay = (managed.replay + footer).slice(-REPLAY_BYTES)
        managed.replayDirty = true
        for (const subscriber of managed.subscribers) subscriber.onOutput(footer)
      }
      for (const subscriber of managed.subscribers) subscriber.onExit(exitCode)
    })

    this.touch(id)
    return toDto(managed)
  }

  rename(projectId: string, terminalId: string, title: string): TerminalDto {
    const managed = this.require(projectId, terminalId)
    managed.title = title
    this.persistMeta(managed)
    return toDto(managed)
  }

  /** Attaches clients, returning prior output for screen restoration and a detach function. */
  attach(
    projectId: string,
    terminalId: string,
    subscriber: TerminalSubscriber,
  ): { replay: string; cols: number; rows: number; exited: boolean; detach: () => void } {
    const managed = this.require(projectId, terminalId)
    managed.subscribers.add(subscriber)
    if (!managed.exited) this.touch(terminalId)

    return {
      replay: managed.replay,
      cols: managed.cols,
      rows: managed.rows,
      exited: managed.exited,
      // Terminals survive the last client leaving: closing tabs must not kill running
      // commands. Inactivity eventually releases them.
      detach: () => managed.subscribers.delete(subscriber),
    }
  }

  write(projectId: string, terminalId: string, data: string): void {
    const managed = this.terminals.get(terminalId)
    if (!managed || managed.projectId !== projectId || managed.exited || !managed.pty) return
    managed.pty.write(data)
    this.touch(terminalId)
  }

  /** Resizes ptys. Multiple clients may view one terminal at different sizes, but ptys have one size. Last writer wins like multiplexers without minimum-size modes. */
  resize(projectId: string, terminalId: string, cols: number, rows: number): void {
    const managed = this.terminals.get(terminalId)
    if (!managed || managed.projectId !== projectId || managed.exited || !managed.pty) return
    if (cols < 1 || rows < 1) return
    if (managed.cols === cols && managed.rows === rows) return

    managed.cols = cols
    managed.rows = rows
    managed.pty.resize(cols, rows)
  }

  /** Terminal only if it belongs to this project. Check here rather than in callers: IDs alone must not expose inaccessible projects' shells. */
  private require(projectId: string, terminalId: string): ManagedTerminal {
    const managed = this.terminals.get(terminalId)
    if (!managed || managed.projectId !== projectId) {
      throw new TerminalError('terminal_not_found', 'Terminal not found.')
    }
    return managed
  }

  close(terminalId: string): void {
    const managed = this.terminals.get(terminalId)
    if (!managed) return

    if (managed.idleTimer) clearTimeout(managed.idleTimer)
    this.terminals.delete(terminalId)
    this.forget(terminalId)
    if (!managed.exited) managed.pty?.kill()
  }

  closeIn(projectId: string, terminalId: string): void {
    this.require(projectId, terminalId)
    this.close(terminalId)
  }

  /** Project deletion: nothing may keep running on its behalf. */
  closeForProject(projectId: string): void {
    for (const managed of this.of(projectId)) this.close(managed.id)
  }

  /** Worktree deletion: shells in vanished directories have no purpose. */
  closeForCwd(cwd: string): void {
    for (const managed of [...this.terminals.values()]) {
      if (managed.cwd === cwd) this.close(managed.id)
    }
  }

  /** Shells in or below a directory, to close before removing it. */
  underCwd(cwd: string): string[] {
    const prefix = cwd.endsWith('/') ? cwd : `${cwd}/`
    return [...this.terminals.values()]
      .filter((managed) => managed.cwd === cwd || managed.cwd.startsWith(prefix))
      .map((managed) => managed.id)
  }

  /** Daemon shutdown writes screens then kills processes while retaining files, which restore entries as interrupted after restart. */
  shutdown(): void {
    clearInterval(this.flushTimer)
    for (const managed of this.terminals.values()) {
      if (managed.idleTimer) clearTimeout(managed.idleTimer)
      this.persistMeta(managed)
      this.flushReplay(managed)
      if (!managed.exited) managed.pty?.kill()
    }
    this.terminals.clear()
  }

  private restore(): void {
    for (const entry of readdirSync(this.storeDir)) {
      if (!entry.endsWith('.json')) continue
      let meta: PersistedTerminal
      try {
        meta = JSON.parse(readFileSync(join(this.storeDir, entry), 'utf8')) as PersistedTerminal
      } catch {
        // Files truncated by abrupt shutdown must neither block startup
        // nor remain to fail again on every restart.
        rmSync(join(this.storeDir, entry), { force: true })
        continue
      }

      let replay = ''
      try {
        replay = readFileSync(join(this.storeDir, `${meta.id}.replay`), 'utf8')
      } catch {
        // No saved screen: the entry still reappears, empty.
      }

      this.terminals.set(meta.id, {
        id: meta.id,
        projectId: meta.projectId,
        title: meta.title,
        pty: null,
        cwd: meta.cwd,
        replay,
        replayDirty: false,
        subscribers: new Set(),
        idleTimer: null,
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
        createdAt: meta.createdAt,
        exited: true,
        interrupted: true,
        actionId: meta.actionId ?? null,
        exitCode: null,
      })
    }
  }

  private persistMeta(managed: ManagedTerminal): void {
    const meta: PersistedTerminal = {
      id: managed.id,
      projectId: managed.projectId,
      title: managed.title,
      cwd: managed.cwd,
      createdAt: managed.createdAt,
      actionId: managed.actionId,
    }
    try {
      writeFileSync(join(this.storeDir, `${managed.id}.json`), JSON.stringify(meta))
    } catch {
      // Full disk or removed directory: the terminal still works; only
      // restoration after restart is lost.
    }
  }

  private flushReplay(managed: ManagedTerminal): void {
    if (!managed.replayDirty) return
    try {
      writeFileSync(join(this.storeDir, `${managed.id}.replay`), managed.replay)
      managed.replayDirty = false
    } catch {
      // Same contract as persistMeta: retry on the next pass.
    }
  }

  private flushDirty(): void {
    for (const managed of this.terminals.values()) this.flushReplay(managed)
  }

  private forget(terminalId: string): void {
    rmSync(join(this.storeDir, `${terminalId}.json`), { force: true })
    rmSync(join(this.storeDir, `${terminalId}.replay`), { force: true })
  }
}

/** Whether shells have running children. Read `/proc` on Linux, use `pgrep` on macOS where `/proc` is absent and no matches exit 1. Elsewhere return false, retaining original inactivity behavior. Query only once per deadline, making synchronous calls negligible. */
function hasChildProcess(pid: number): boolean {
  try {
    if (process.platform === 'darwin') {
      return execFileSync('pgrep', ['-P', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().length > 0
    }
    return readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim().length > 0
  } catch {
    return false
  }
}

function toDto(managed: ManagedTerminal): TerminalDto {
  return {
    id: managed.id,
    title: managed.title,
    alive: !managed.exited,
    interrupted: managed.interrupted,
    cwd: managed.cwd,
    createdAt: managed.createdAt,
    actionId: managed.actionId,
    exitCode: managed.exitCode,
  }
}

/** First free number keeps labels readable after closures. */
function nextTitle(existing: ManagedTerminal[]): string {
  const taken = new Set(existing.map((managed) => managed.title))
  for (let index = 1; ; index += 1) {
    const candidate = `shell ${index}`
    if (!taken.has(candidate)) return candidate
  }
}
