import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { BrowserClientMessage, BrowserDto, BrowserListDto, BrowserServerMessage, BrowserStatusDto } from '@sillage/protocol'
import { api } from './api'

/**
 * Agent browsers (card #112): data and the live connection. Screens decide how to show them: the
 * conversation panel, the Services list, the thread shortcut.
 */

const STATUS_KEY = ['browser-status']
const LIST_KEY = ['browsers']

export function useBrowserStatus() {
  return useQuery({
    queryKey: STATUS_KEY,
    queryFn: () => api.get<BrowserStatusDto>('/api/browser/status'),
    // Follow an install while it runs; otherwise the status only changes when someone acts.
    refetchInterval: (query) => (query.state.data?.installing ? 1000 : false),
  })
}

export function useInstallBrowser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.post<BrowserStatusDto>('/api/browser/install'),
    onSuccess: (status) => queryClient.setQueryData(STATUS_KEY, status),
  })
}

/** Open browsers visible to this account; polled because they open and close as agents work. */
export function useBrowsers() {
  return useQuery({
    queryKey: LIST_KEY,
    queryFn: () => api.get<BrowserListDto>('/api/browsers'),
    refetchInterval: 5000,
    select: (data) => data.browsers,
  })
}

export function useCloseBrowser() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (conversationId: string) => api.delete<void>(`/api/conversations/${conversationId}/browser`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: LIST_KEY }),
  })
}

export interface BrowserFrame {
  /** Object URL of the latest JPEG; replaced (and the previous one revoked) at each frame. */
  url: string
  /** Page size in CSS pixels, to map pointer positions back onto the page. */
  width: number
  height: number
}

export interface BrowserLive {
  connected: boolean
  browser: BrowserDto | null
  watching: string | null
  frame: BrowserFrame | null
  error: string | null
  send: (message: BrowserClientMessage) => void
}

/**
 * Live view of a conversation's browser. Frames arrive only while the page repaints; the socket
 * stays open while mounted so a browser the agent opens later appears without reloading.
 */
export function useBrowserLive(conversationId: string): BrowserLive {
  const [connected, setConnected] = useState(false)
  const [browser, setBrowser] = useState<BrowserDto | null>(null)
  const [watching, setWatching] = useState<string | null>(null)
  const [frame, setFrame] = useState<BrowserFrame | null>(null)
  const [error, setError] = useState<string | null>(null)
  const socket = useRef<WebSocket | null>(null)

  useEffect(() => {
    let closed = false
    let retry: ReturnType<typeof setTimeout> | null = null
    let current: string | null = null

    const connect = () => {
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/conversations/${conversationId}/browser/live`)
      socket.current = ws
      ws.onopen = () => setConnected(true)
      ws.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as BrowserServerMessage
        if (message.t === 'state') {
          setBrowser(message.browser)
          setWatching(message.watching)
          if (!message.browser) setFrame(null)
        } else if (message.t === 'frame') {
          const bytes = Uint8Array.from(atob(message.data), (char) => char.charCodeAt(0))
          const url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }))
          if (current) URL.revokeObjectURL(current)
          current = url
          setFrame({ url, width: message.width, height: message.height })
          setError(null)
        } else {
          setError(message.message)
        }
      }
      ws.onclose = () => {
        setConnected(false)
        if (!closed) retry = setTimeout(connect, 2000)
      }
    }
    connect()
    return () => {
      closed = true
      if (retry) clearTimeout(retry)
      socket.current?.close()
      socket.current = null
      if (current) URL.revokeObjectURL(current)
      setBrowser(null)
      setFrame(null)
    }
  }, [conversationId])

  const send = useCallback((message: BrowserClientMessage) => {
    const ws = socket.current
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
  }, [])

  return { connected, browser, watching, frame, error, send }
}
