/**
 * Background work started without `await`: timers, sweeps, the delivery that follows an
 * accepted message. One daemon hosts every session, so a rejection nobody observes must cost a
 * log line, not the process. Prefer this to a bare `void` whenever the callee can reject, which
 * includes any path that writes to SQLite (a deleted conversation, a busy database).
 */
export function detach(promise: Promise<unknown>, label: string): void {
  promise.catch((err: unknown) => console.error(`sillage: ${label} failed`, err))
}

type FaultHandlers = {
  /** Called once on the first uncaught exception, to stop runners and close the database. */
  onFatal: (err: unknown) => Promise<void>
  /** Exit code and delay used when `onFatal` does not end the process in time. */
  deadlineMs?: number
  exit?: (code: number) => void
}

/**
 * The process-wide net behind `detach`. Node exits on an unhandled rejection by default, which
 * here interrupts every running turn of every project, and repeats at each boot when the failing
 * sweep finds the same row again. A rejection is one failed task whose caller is gone: log it and
 * keep serving. An uncaught exception may have left state half-written, so it still ends the
 * process, but through the orderly shutdown so CLIs are stopped rather than orphaned.
 */
export function installFaultPolicy(handlers: FaultHandlers): () => void {
  const { onRejection, onException } = faultHandlers(handlers)
  process.on('unhandledRejection', onRejection)
  process.on('uncaughtException', onException)
  return () => {
    process.off('unhandledRejection', onRejection)
    process.off('uncaughtException', onException)
  }
}

/** The listeners behind `installFaultPolicy`, separate so tests can drive them without raising real process events. */
export function faultHandlers({ onFatal, deadlineMs = 10_000, exit = (code) => process.exit(code) }: FaultHandlers) {
  let fatal = false
  return {
    onRejection(reason: unknown): void {
      console.error('sillage: unhandled rejection, daemon kept running', reason)
    },
    onException(err: unknown): void {
      console.error('sillage: uncaught exception, shutting down', err)
      if (fatal) return
      fatal = true
      // The shutdown itself may hang or throw; the deadline still ends the process.
      setTimeout(() => exit(1), deadlineMs).unref()
      onFatal(err)
        .catch((shutdownErr: unknown) => console.error('sillage: shutdown after a fatal error failed', shutdownErr))
        .finally(() => exit(1))
    },
  }
}
