import { query, type Options, type Query, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { AsyncQueue } from '../async-queue.js'
import { sdkExecutable } from '../launch.js'

/**
 * Open Claude session for a control request, then close.
 *
 * `supportedModels()`, `supportedCommands()`, `usage…()` need live CLI but no messages: empty input
 * queue, start/respond/stop without tokens or quota. Shared queue/abort/timeout/cleanup skeleton
 * prevents repeating lifecycle fixes across catalogs.
 *
 * Process costs ~400 MB while probing. Global cap bounds simultaneous launches: draft worktree
 * clicks change probed cwd, otherwise every click starts another parallel CLI.
 */

const DEFAULT_TIMEOUT_MS = 20_000
const MAX_CONCURRENT = 2

interface ControlSessionOptions {
  /**
   * Always supplied instead of SDK resolution, which searches platform package
   * `@anthropic-ai/claude-agent-sdk-<os>-<arch>` no longer shipped. Without path, probe fails
   * “Native CLI binary not found” in milliseconds, falsely suggesting missing installed agent.
   */
  executable: () => Promise<string>
  cwd: string
  /** Forwarded stderr prefix: `[claude <tag>]`. */
  tag: string
  timeoutMs?: number
  /** Probe-specific launch options beyond common base. */
  options?: Omit<Options, 'cwd' | 'abortController' | 'pathToClaudeCodeExecutable' | 'stderr'>
}

export async function withControlSession<T>(
  { executable, cwd, tag, timeoutMs = DEFAULT_TIMEOUT_MS, options }: ControlSessionOptions,
  fn: (session: Query) => Promise<T>,
): Promise<T> {
  const release = await acquire()
  const input = new AsyncQueue<SDKUserMessage>()
  const abort = new AbortController()
  let timedOut = false

  try {
    const session = query({
      prompt: input,
      options: {
        ...options,
        cwd,
        abortController: abort,
        pathToClaudeCodeExecutable: sdkExecutable(await executable()),
        // CLI stderr alone explains probe failure: discarding leaves unexplained 502.
        stderr: (data) => process.stderr.write(`[claude ${tag}] ${data}`),
      },
    })

    const timer = setTimeout(() => {
      timedOut = true
      abort.abort()
    }, timeoutMs)
    try {
      return await fn(session)
    } catch (err) {
      // SDK only says “Query closed before response received” on abort: 502 readers must know
      // timeout caused it.
      if (timedOut) {
        throw new Error(`Claude CLI did not answer within ${Math.round(timeoutMs / 1000)}s`)
      }
      throw err
    } finally {
      clearTimeout(timer)
      input.close()
      abort.abort()
    }
  } finally {
    release()
  }
}

/** Minimal semaphore: requests above cap wait their turn. */
let running = 0
const waiting: Array<() => void> = []

async function acquire(): Promise<() => void> {
  if (running >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => waiting.push(resolve))
  }
  running += 1
  return () => {
    running -= 1
    waiting.shift()?.()
  }
}
