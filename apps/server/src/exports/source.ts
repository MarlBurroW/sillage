import { setImmediate as yieldLoop } from 'node:timers/promises'
import MarkdownIt from 'markdown-it'
import { EXPORT_MAX_BYTES, type ExportField, type ExportItemDto, type ExportOptions, type ExportSelectionOptions, type ExportSelectionDto, type EventBodyRef, type SillageEvent } from '@sillage/protocol'
import { applyEvent, emptyChatState, type ChatItem } from '@sillage/protocol/chat-state'
import type { EventLog } from '../events/event-log.js'
import { coalesceDeltas } from '../events/coalesce.js'
import { badRequest } from '../http/errors.js'
import { exportText } from './labels.js'

export interface ExportImage { id: string; label: string; source: string; available: boolean; data?: string }
export interface ExportEntry {
  id: string
  kind: ExportItemDto['kind'] | 'gap'
  role: 'user' | 'assistant'
  fields: ExportField[]
  images: ExportImage[]
  tool?: { name: string; input?: EventBodyRef; output?: EventBodyRef; status: string }
  /** Used only by the owner's selector; never included in the exported document's fields. */
  privateTitle?: string
  partial: boolean
}
export interface ExportDocument {
  entries: ExportEntry[]
  fields: ExportField[]
  images: ExportImage[]
  options: ExportOptions
  excerpt: boolean
}
const markdown = new MarkdownIt({ html: false })
const retained = new Set([
  'message.completed', 'message.delta', 'tool.started', 'tool.input_updated', 'tool.completed',
  'turn.started', 'turn.completed', 'session.ended',
  'question.requested', 'question.resolved', 'plan.review_requested', 'plan.review_resolved',
])

/** Use immutable event positions, never mutable native IDs or the live projection cursor. */
export async function captureEntries(log: EventLog, conversationId: string, throughSeq: number,
  locale: 'en' | 'fr', signal: AbortSignal, progress: (fraction: number) => void): Promise<ExportEntry[]> {
  let state = emptyChatState(), cursor = 0, bytes = 0
  while (cursor < throughSeq) {
    signal.throwIfAborted()
    let page: ReturnType<EventLog['readForReplay']>
    try {
      page = log.readForReplay(conversationId, cursor, {
        rows: 256, bytes: 1024 * 1024, bodies: true, unfiltered: true, throughSeq,
        onlyTypes: [...retained], maxEventBytes: EXPORT_MAX_BYTES,
      })
    } catch (error) {
      if (error instanceof RangeError) throw badRequest('export_too_large', 'Export is too large.')
      throw error
    }
    if (page.nextAfter <= cursor) break
    for (const entry of coalesceDeltas(page.entries)) {
      let event = entry.event
      // Retain parent relationships through the fold: a child can reuse a native tool ID,
      // and its completion must never be attached to an earlier top-level call.
      if (!retained.has(event.type)) continue
      if (event.type === 'tool.started' || event.type === 'tool.input_updated') {
        event = { ...event, input: null, inputRef: { seq: entry.seq, field: 'input' } }
      } else if (event.type === 'tool.completed') {
        event = { ...event, output: null, outputRef: { seq: entry.seq, field: 'output' } }
      } else if (event.type === 'message.completed') {
        event = { ...event, blocks: event.blocks.filter(block => ['text', 'image', 'tool_use', 'tool_result'].includes(block.type))
          .map((block, index) => {
            // Existing refs keep their original block index after filtering.
            const originalIndex = entry.event.type === 'message.completed' ? entry.event.blocks.indexOf(block) : index
            if (block.type === 'tool_use') return { ...block, input: null, inputRef: { seq: entry.seq, field: 'input' as const, block: originalIndex } }
            if (block.type === 'tool_result') return { ...block, output: null, outputRef: { seq: entry.seq, field: 'output' as const, block: originalIndex } }
            return block
          }) }
      }
      bytes += Buffer.byteLength(JSON.stringify(event))
      if (bytes > EXPORT_MAX_BYTES * 2) throw badRequest('export_too_large', 'Export is too large.')
      state = applyEvent(state, entry.seq, entry.ts, event as SillageEvent)
    }
    cursor = page.nextAfter
    progress(Math.min(1, cursor / Math.max(1, throughSeq)))
    await yieldLoop()
  }
  return state.items.flatMap(item => toEntry(item, locale))
}

function toEntry(item: ChatItem, locale: 'en' | 'fr'): ExportEntry[] {
  if (!['message', 'tool', 'question', 'plan'].includes(item.kind)) return []
  if ('parentToolCallId' in item && item.parentToolCallId) return []
  const id = String(item.position ?? ('seq' in item ? item.seq : item.id))
  const fields: ExportField[] = [], images: ExportImage[] = []
  const text = (value: string, kind: ExportField['kind']) => {
    if (value.trim()) fields.push({ id: id + '.' + fields.length, kind, text: value, entryId: id })
  }
  const image = (source: string, label: string) => {
    images.push({ id: id + '.image.' + images.length, source, label,
      available: !/^(?:https?:|\/\/|blob:)/i.test(source) && !/\.svg(?:[?#]|$)/i.test(source) })
  }
  if (item.kind === 'message') {
    for (const block of item.blocks) {
      if (block.type === 'text') {
        text(block.text, 'message')
        for (const token of markdown.parse(block.text, {})) for (const child of token.children ?? []) {
          if (child.type === 'image') image(child.attrGet('src') ?? '', child.content)
        }
      }
      if (block.type === 'image') image(block.url, '')
    }
    text(item.streamingText, 'message')
    if (!fields.length && !images.length) return []
    return [{ id, kind: 'message', role: item.role, fields, images, partial: !!item.streamingText }]
  }
  if (item.kind === 'tool') return [{ id, kind: 'tool', role: 'assistant', fields, images, privateTitle: (item.title || item.presentation?.label || item.name).slice(0, 1000), partial: item.status === 'running' || item.status === 'interrupted',
    tool: { name: item.name, input: item.inputRef, output: item.outputRef, status: item.status } }]
  if (item.kind === 'question') {
    for (const question of item.questions) {
      text(question.question, 'question')
      text(item.answers[question.id]?.join('\n') || exportText(locale)('export.page.noAnswer'), 'question')
    }
    return [{ id, kind: 'question', role: 'assistant', fields, images, partial: item.status === 'pending' }]
  }
  if (item.kind === 'plan') {
    text(item.plan, 'plan')
    return [{ id, kind: 'plan', role: 'assistant', fields, images, partial: item.status === 'pending' }]
  }
  return []
}

export function toolCategory(name: string): 'read' | 'change' | 'run' | 'other' {
  if (/(read|search|grep|glob|find|fetch|list|view)/i.test(name)) return 'read'
  if (/(edit|write|patch|update|create)/i.test(name)) return 'change'
  if (/(bash|shell|exec|command|terminal)/i.test(name)) return 'run'
  return 'other'
}

export function entryDto(entry: ExportEntry, locale: 'en' | 'fr'): ExportItemDto {
  return {
    id: entry.id, kind: entry.kind as ExportItemDto['kind'], role: entry.role,
    text: entry.tool ? (entry.privateTitle ? entry.privateTitle + ' · ' : '') + exportText(locale)(('export.page.' + toolCategory(entry.tool.name)) as 'export.page.read')
      : entry.fields.map(field => field.text).join('\n').slice(0, 1000),
    images: entry.images.map(({ id, label, available }) => ({ id, label, available })),
  }
}

/** Tool payloads may carry inline media too. Selecting textual output must not opt those in. */
function toolText(value: unknown, locale: 'en' | 'fr'): string {
  const omitted = exportText(locale)('export.page.imageOmitted')
  const clean = (value: unknown): unknown => {
    if (typeof value === 'string') return value.replace(/data:[^\s,]+;base64,[A-Za-z0-9+/=]+/g, omitted)
    if (Array.isArray(value)) return value.map(clean)
    if (value && typeof value === 'object') {
      const object = value as Record<string, unknown>
      if (typeof object.type === 'string' && /^(image|audio|video|file)$/.test(object.type)) return omitted
      return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, key === 'blob' ? omitted : clean(value)]))
    }
    return value
  }
  const cleaned = clean(value)
  return typeof cleaned === 'string' ? cleaned : JSON.stringify(cleaned, null, 2) ?? ''
}

function selectionScope(entries: ExportEntry[], options: ExportSelectionOptions) {
  const from = options.from === null ? 0 : entries.findIndex(entry => entry.id === options.from)
  const to = options.to === null ? entries.length - 1 : entries.findIndex(entry => entry.id === options.to)
  const ids = new Set(entries.map(entry => entry.id))
  const toolIds = new Set(entries.filter(entry => entry.tool).map(entry => entry.id))
  if (from < 0 || (options.to !== null && to < 0) || (to < from && entries.length > 0) || options.excluded.some(id => !ids.has(id)) ||
    Object.keys(options.toolOverrides).some(id => !toolIds.has(id))) throw badRequest('export_invalid', 'Invalid export selection.')
  const excluded = new Set(options.excluded)
  const includes = (entry: ExportEntry) => !excluded.has(entry.id) &&
    !(entry.tool && (options.toolOverrides[entry.id] ?? options.tools).mode === 'hidden')
  return { from, to, excluded, includes, entries: entries.slice(from, to + 1) }
}

/** Count the same selection as rendering without reading any tool payloads. */
export function describeSelection(entries: ExportEntry[], options: ExportSelectionOptions, locale: 'en' | 'fr'): ExportSelectionDto {
  const scope = selectionScope(entries, options)
  const selected = scope.entries.filter(scope.includes)
  const images = new Set(options.images)
  const tools = selected.filter(entry => entry.tool).length
  const first = entries[scope.from], last = entries[scope.to]
  return {
    included: selected.length, messages: selected.length - tools, tools,
    images: selected.reduce((count, entry) => count + entry.images.filter(image => images.has(image.id)).length, 0),
    from: options.from && first ? entryDto(first, locale) : null,
    to: options.to && last ? entryDto(last, locale) : null,
  }
}

export async function selectDocument(entries: ExportEntry[], options: ExportOptions,
  body: (ref: EventBodyRef) => unknown, signal: AbortSignal): Promise<ExportDocument> {
  const scope = selectionScope(entries, options)
  const { from, to, excluded } = scope
  const fields: ExportField[] = [
    { id: 'title', kind: 'title', text: options.title, entryId: null },
    { id: 'introduction', kind: 'introduction', text: options.introduction, entryId: null },
    { id: 'author', kind: 'author', text: options.author, entryId: null },
  ]
  const selected: ExportEntry[] = [], images: ExportImage[] = []
  const selectedImages = new Set(options.images)
  let bytes = fields.reduce((size, field) => size + Buffer.byteLength(field.text), 0), omitted = false
  for (const original of scope.entries) {
    signal.throwIfAborted()
    const mode = options.toolOverrides[original.id] ?? options.tools
    if (excluded.has(original.id)) { omitted = true; continue }
    if (!scope.includes(original)) continue
    if (omitted && selected.length) selected.push({ id: 'gap.' + original.id, kind: 'gap', role: 'assistant', fields: [], images: [], partial: false })
    omitted = false
    const entry = { ...original, fields: [...original.fields], images: original.images.filter(image => selectedImages.has(image.id)) }
    if (entry.tool && mode.mode === 'details') {
      for (const field of ['input', 'output'] as const) {
        const ref = entry.tool[field]
        if (mode[field] && ref) {
          const value = body(ref)
          const content = toolText(value, options.locale)
          if (content) entry.fields.push({ id: entry.id + '.' + field, kind: field, text: content, entryId: entry.id })
        }
      }
    }
    for (const image of entry.images) {
      if (!image.available) throw badRequest('export_image_missing', 'Image unavailable.')
      entry.fields.push({ id: image.id + '.caption', kind: 'caption', text: image.label, entryId: entry.id })
      images.push(image)
    }
    fields.push(...entry.fields)
    bytes += entry.fields.reduce((size, field) => size + Buffer.byteLength(field.text), 0)
    if (bytes > EXPORT_MAX_BYTES) throw badRequest('export_too_large', 'Export is too large.')
    selected.push(entry)
    await yieldLoop()
  }
  if (!selected.some(entry => entry.kind !== 'gap') || options.images.some(id => !images.some(image => image.id === id))) {
    throw badRequest('export_invalid', 'Invalid export selection.')
  }
  return { entries: selected, fields, images, options,
    excerpt: from !== 0 || to !== entries.length - 1 || excluded.size > 0 || options.tools.mode !== 'details' }
}
