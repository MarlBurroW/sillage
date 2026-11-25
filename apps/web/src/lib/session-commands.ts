import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'

/**
 * Actions of the open conversation that need its page: dialogs, thread search, compaction. The page
 * publishes them with the conditions its toolbar already applies, and the palette lists what is
 * published, so a command never appears where its button would not. Outside React because the two
 * live in different parts of the shell with nothing else to share.
 */
export interface SessionCommand {
  key: string
  label: string
  icon: ReactNode
  run: () => void
}

const NONE: readonly SessionCommand[] = []
let published: readonly SessionCommand[] = NONE
const listeners = new Set<() => void>()

function publish(next: readonly SessionCommand[]): void {
  published = next
  for (const listener of listeners) listener()
}

/**
 * Publish the page's commands. The list may be rebuilt on every render, as a page that streams
 * tokens does: subscribers are only told when a command appears, disappears or changes its label,
 * and each published `run` calls the latest handler.
 */
export function usePublishSessionCommands(commands: readonly SessionCommand[]): void {
  const latest = useRef(commands)
  useEffect(() => {
    latest.current = commands
  })
  const signature = commands.map((command) => `${command.key}\u0000${command.label}`).join('\u0001')
  useEffect(() => {
    publish(latest.current.map((command) => ({
      ...command,
      run: () => latest.current.find((entry) => entry.key === command.key)?.run(),
    })))
    return () => publish(NONE)
  }, [signature])
}

export function useSessionCommands(): readonly SessionCommand[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => published,
    () => NONE,
  )
}
