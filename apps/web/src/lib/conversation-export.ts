import { useCallback, useEffect, useState } from 'react'
import type { ExportDraftDto, ExportOptions, ExportRenderRequest, ConversationShareDto } from '@sillage/protocol'
import { api, ApiRequestError } from './api'
import { locale, translate, translateError } from './i18n'

export const exportUrl = (id: string) => '/api/exports/' + encodeURIComponent(id)
export const exportImageUrl = (id: string, image: string) => exportUrl(id) + '/images/' + encodeURIComponent(image)
const pending = new Set<ExportDraftDto['status']>(['preparing', 'analyzing', 'rendering'])

/** Keeps preparation, polling and cancellation independent from the export dialog's layout. */
export function useConversationExport(conversationId: string) {
  const [draft, setDraft] = useState<ExportDraftDto | null>(null)
  const [review, setReview] = useState<ExportDraftDto | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [retryTick, setRetryTick] = useState(0)
  const [generation, setGeneration] = useState(0)
  const [expired, setExpired] = useState(false)
  const fail = useCallback((error: unknown) => {
    setError(error instanceof Error ? error.message : translate('export.failed'))
    if (error instanceof ApiRequestError && error.code === 'export_expired') setExpired(true)
  }, [])

  useEffect(() => {
    let alive = true, created: ExportDraftDto | null = null
    setDraft(null); setReview(null); setError(null); setExpired(false)
    void api.post<ExportDraftDto>('/api/conversations/' + conversationId + '/exports', { locale: locale() }).then(result => {
      created = result
      if (alive) setDraft(result)
      else void api.delete(exportUrl(result.id)).catch(() => {})
    }).catch(error => { if (alive) fail(error) })
    return () => {
      alive = false
      if (created) void api.delete(exportUrl(created.id)).catch(() => {})
    }
  }, [conversationId, generation, fail])

  useEffect(() => {
    if (!draft || !pending.has(draft.status)) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    const poll = () => {
      void api.get<ExportDraftDto>(exportUrl(draft.id), controller.signal).then(result => { setDraft(result); setError(null) }).catch(error => {
        if (!controller.signal.aborted) { fail(error); timer = setTimeout(poll, 2000) }
      })
    }
    timer = setTimeout(poll, 450)
    return () => { clearTimeout(timer); controller.abort() }
  }, [draft, fail, retryTick])

  useEffect(() => {
    if (!draft || draft.status !== 'review') return
    const controller = new AbortController()
    void api.get<ExportDraftDto>(exportUrl(draft.id) + '/review', controller.signal).then(result => { setReview(result); setError(null) }).catch(error => {
      if (!controller.signal.aborted) fail(error)
    })
    return () => controller.abort()
  }, [draft, fail, retryTick])

  const request = async (path: string, body: unknown) => {
    if (!draft) return
    setSending(true); setError(null)
    try { setDraft(await api.post<ExportDraftDto>(exportUrl(draft.id) + path, body)) }
    catch (error) { fail(error) }
    finally { setSending(false) }
  }
  const analyze = (options: ExportOptions) => { setReview(null); return request('/analyze', options) }
  const render = (decisions: Omit<ExportRenderRequest, 'revision'>) => request('/render', { ...decisions, revision: draft?.revision })
  const publish = async (expiresAt: number | null): Promise<ConversationShareDto | null> => {
    if (!draft) return null
    setPublishing(true); setError(null)
    try { return await api.post<ConversationShareDto>(exportUrl(draft.id) + '/publish', { revision: draft.revision, expiresAt }) }
    catch (error) { fail(error); return null }
    finally { setPublishing(false) }
  }
  return {
    draft, review, analyze, render, publish, sending, publishing,
    busy: sending || !!draft && pending.has(draft.status),
    error: error ?? (draft?.error ? translateError(draft.error, translate('export.failed')) : null),
    retry: () => { setError(null); if (!draft || expired || draft.status === 'failed') setGeneration(value => value + 1); else setRetryTick(value => value + 1) },
  }
}
