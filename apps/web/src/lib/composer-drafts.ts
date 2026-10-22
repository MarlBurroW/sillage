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

export function readDraft(key: string): ComposerDraft {
  return drafts.get(key) ?? EMPTY
}

export function saveDraft(key: string, draft: ComposerDraft): void {
  // An empty draft is not a draft: retaining it grows the table with every visited conversation and
  // masks fork `initialText`.
  if (draft.text.length === 0 && draft.attachments.length === 0) {
    drafts.delete(key)
    return
  }
  drafts.set(key, draft)
}
