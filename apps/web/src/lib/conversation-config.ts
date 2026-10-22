import { useMemo, useSyncExternalStore } from 'react'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { agentConfigSchema, type AgentConfig, type ConversationDto } from '@sillage/protocol'
import { api } from './api'

interface Snapshot {
  chosen: AgentConfig | null
  error: Error | null
}

/** One queue per conversation, retained if the user navigates away during writing. */
class ConfigWriter {
  private snapshot: Snapshot = { chosen: null, error: null }
  private listeners = new Set<() => void>()
  private pending: Promise<void> | null = null
  private revision = 0

  constructor(private client: QueryClient, private id: string) {}

  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private publish(snapshot: Snapshot) {
    this.snapshot = snapshot
    this.listeners.forEach((listener) => listener())
  }

  change = (chosen: AgentConfig) => {
    const revision = ++this.revision
    this.publish({ chosen, error: null })
    // Send each request after the previous: the last choice stays the last write even when live CLI
    // application takes longer than a click.
    this.pending = (this.pending ?? Promise.resolve()).then(async () => {
      try {
        await api.patch(`/api/conversations/${this.id}`, { config: chosen })
        if (revision !== this.revision) return
        const key = ['conversation', this.id]
        await this.client.cancelQueries({ queryKey: key })
        if (revision !== this.revision) return
        this.client.setQueryData<ConversationDto>(key, (current) => current ? { ...current, config: chosen } : current)
        this.publish({ chosen: null, error: null })
        void this.client.invalidateQueries({ queryKey: key })
      } catch (error) {
        // An earlier failure must not overwrite newer choices already queued.
        if (revision === this.revision) this.publish({ chosen, error: error instanceof Error ? error : new Error(String(error)) })
      } finally {
        if (revision === this.revision) this.pending = null
      }
    })
  }

  retry = () => { if (this.snapshot.chosen) this.change(this.snapshot.chosen) }

  /** Messages wait for selected settings, including choices added while waiting. */
  flush = async () => {
    while (this.pending) await this.pending
    if (this.snapshot.error) throw this.snapshot.error
  }
}

const writers = new WeakMap<QueryClient, Map<string, ConfigWriter>>()

export function useConversationConfig(conversation: ConversationDto | undefined) {
  const client = useQueryClient()
  const id = conversation?.id ?? ''
  const writer = useMemo(() => {
    let byId = writers.get(client)
    if (!byId) { byId = new Map(); writers.set(client, byId) }
    let entry = byId.get(id)
    if (!entry) { entry = new ConfigWriter(client, id); byId.set(id, entry) }
    return entry
  }, [client, id])
  const snapshot = useSyncExternalStore(writer.subscribe, writer.getSnapshot)
  const stored = useMemo(() => conversation ? agentConfigSchema.parse(conversation.config) : null, [conversation])

  return { config: snapshot.chosen ?? stored, error: snapshot.error, change: writer.change, retry: writer.retry, flush: writer.flush }
}
