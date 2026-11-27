import { randomUUID } from 'node:crypto'
import type { SillageEvent } from '@sillage/protocol'

/**
 * Streamed text and reasoning of ACP agents, one block open per thread. ACP chunks carry no
 * message IDs: a block lasts until another kind of content interrupts it on the same thread.
 * Sub-agents stream at the same time as their parent, so each spawning call (`parentToolCallId`)
 * has its own lane; the main thread is lane null. Same logic as Copilot's `streams`, kept apart
 * so that the ACP runners can share it (card #39).
 */
export class TextLanes {
  private readonly lanes = new Map<string, { kind: 'text' | 'thinking'; id: string; text: string }>()

  constructor(private readonly emit: (event: SillageEvent) => void) {}

  append(kind: 'text' | 'thinking', text: string, parent: string | null): void {
    if (!text) return
    const lane = parent ?? ''
    let open = this.lanes.get(lane)
    if (open && open.kind !== kind) { this.close(parent); open = undefined }
    if (!open) { open = { kind, id: randomUUID(), text: '' }; this.lanes.set(lane, open) }
    open.text += text
    this.emit({ type: kind === 'text' ? 'message.delta' : 'thinking.delta', messageId: open.id, text, parentToolCallId: parent })
  }

  /** Completes the block open on one thread, or on all of them. */
  close(parent?: string | null): void {
    for (const lane of parent === undefined ? [...this.lanes.keys()] : [parent ?? '']) {
      const open = this.lanes.get(lane)
      this.lanes.delete(lane)
      if (open?.text.trim()) {
        this.emit({ type: 'message.completed', messageId: open.id, role: 'assistant', blocks: [{ type: open.kind, text: open.text }], parentToolCallId: lane || null })
      }
    }
  }
}
