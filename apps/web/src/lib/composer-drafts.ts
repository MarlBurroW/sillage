import type { AttachmentDto } from '@sillage/protocol'

/**
 * Message drafts per conversation. The composer remounts by key on conversation changes; without
 * external memory, switching erased entered text and uploaded attachments without warning. Store
 * outside React to survive those unmounts. Deliberately not persisted: attachment IDs refer to
 * uploaded files the server eventually collects as orphans, so restored drafts after restart could
 * reference missing files and fail to send.
 */
export interface ComposerDraft {
  text: string
  attachments: AttachmentDto[]
  /** Paths selected from mention suggestions, distinct from manually typed `@` references. */
  mentions: string[]
  /** Skills selected from suggestions by name. */
  skills: string[]
}

const EMPTY: ComposerDraft = { text: '', attachments: [], mentions: [], skills: [] }

const drafts = new Map<string, ComposerDraft>()

/** Listeners for `hasUnsentDrafts`, told only when the answer may have changed. */
const listeners = new Set<() => void>()

/**
 * Whether some conversation holds unsent text or attachments. Drafts live in memory only, so a
 * reload loses them: the update prompt warns before offering one.
 */
export function hasUnsentDrafts(): boolean {
  return drafts.size > 0
}

export function subscribeDrafts(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notify(before: boolean): void {
  if (before !== hasUnsentDrafts()) for (const listener of listeners) listener()
}

export function readDraft(key: string): ComposerDraft {
  return drafts.get(key) ?? EMPTY
}

export function saveDraft(key: string, draft: ComposerDraft): void {
  // An empty draft is not a draft: retaining it grows the table with every visited conversation and
  // masks fork `initialText`.
  const before = hasUnsentDrafts()
  if (draft.text.length === 0 && draft.attachments.length === 0) {
    drafts.delete(key)
  } else {
    drafts.set(key, draft)
  }
  notify(before)
}
