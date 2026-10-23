import { deserializeChatState, type ChatState, type ThreadPage } from '@sillage/protocol/chat-state'
import { api } from './api'
import { translate } from './i18n'

export async function fetchThreadPage(id: string, signal: AbortSignal, before?: number, after?: number) {
  const query = new URLSearchParams()
  if (before !== undefined) query.set('before', String(before))
  if (after !== undefined) query.set('after', String(after))
  const started = performance.now()
  for (;;) {
    const page = await api.get<ThreadPage>(`/api/conversations/${id}/thread?${query}`, signal)
    if (!page.building) return { ...page, state: deserializeChatState(page.state) }
    if (page.unavailable) throw new Error(translate('journal.content.error'))
    if (performance.now() - started > 60_000) throw new Error(translate('journal.content.error'))
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason) }
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, 150)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }
}

/** Page and patches describe one exact cursor, including edits to previously loaded rows. */
export function mergeThreadPage(current: ChatState, page: ChatState): ChatState {
  const items = new Map(current.items.map((item) => [item.position, item]))
  for (const item of page.items) items.set(item.position, item)
  const checkpoints = new Map(current.checkpoints.map((item) => [item.key, item]))
  for (const item of page.checkpoints) checkpoints.set(item.key, item)
  const edits = new Map(current.editTurns.map((item) => [item.id, item]))
  for (const item of page.editTurns) edits.set(item.id, item)
  return { ...page, items: [...items.values()].sort((a,b) => a.position! - b.position!),
    tasks: new Map([...current.tasks, ...page.tasks]),
    checkpoints: [...checkpoints.values()].sort((a,b) => a.seq-b.seq),
    editTurns: [...edits.values()].sort((a,b) => (a.seq ?? a.ts)-(b.seq ?? b.ts)) }
}
