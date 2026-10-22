import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { useEffect, useRef, useState } from 'react'
import type { TerminalClientMessage, TerminalServerMessage } from '@sillage/protocol'
import { cx } from '../ui'
import '@xterm/xterm/css/xterm.css'
import { translate, useTranslate } from '../../lib/i18n'

/**
 * Terminal connected to its PTY through a dedicated socket. Copy/paste determines web-shell
 * usability. Ctrl+C must retain SIGINT, the only way to interrupt commands; replacing it with copy
 * would break shells. Copy on selection like PuTTY, with explicit Ctrl+Shift+C; paste using Ctrl+V
 * or right-click. LAN HTTP access lacks navigator.clipboard, so every gesture needs a path
 * independent of it.
 */

/** The server PTY follows view size, but not every pixel of a resize gesture. */
const RESIZE_DEBOUNCE_MS = 120

/**
 * Resolve app tokens before passing to xterm. CSS var() cannot work in xterm's font measurement
 * context; silent failure prevents FitAddon dimensions and freezes initial terminal size regardless
 * of available space.
 */
/**
 * Write to clipboard even in insecure contexts. Fallback uses an offscreen textarea and
 * execCommand(copy), the only HTTP path, requiring a user gesture. It steals focus briefly, so
 * callers restore terminal focus.
 */
function copyText(text: string) {
  if (navigator.clipboard) {
    void navigator.clipboard.writeText(text)
    return
  }
  const scratch = document.createElement('textarea')
  scratch.value = text
  scratch.setAttribute('readonly', '')
  scratch.style.position = 'fixed'
  scratch.style.opacity = '0'
  document.body.append(scratch)
  scratch.select()
  document.execCommand('copy')
  scratch.remove()
}

function readTokens(root: HTMLElement) {
  const styles = getComputedStyle(root)
  const token = (name: string) => styles.getPropertyValue(name).trim()

  return {
    fontFamily: token('--font-mono') || 'ui-monospace, monospace',
    theme: {
      background: token('--sg-sunken'),
      foreground: token('--sg-ink'),
      cursor: token('--sg-accent'),
      cursorAccent: token('--sg-sunken'),
      selectionBackground: token('--sg-accent-wash'),
    },
  }
}

export function TerminalView({
  projectId,
  terminalId,
  /** Changes when the tab becomes visible: hidden xterm cannot measure itself. */
  visible,
}: {
  projectId: string
  terminalId: string
  visible: boolean
}) {
  const t = useTranslate()
  const host = useRef<HTMLDivElement>(null)
  const fit = useRef<FitAddon | null>(null)
  /**
   * Current visibility in a ref rather than an effect closure. Initial mount precedes tab selection
   * and captures false; retaining it made resizing silently exit forever and froze initial width.
   */
  const shown = useRef(visible)
  shown.current = visible
  const [status, setStatus] = useState<'connecting' | 'ready' | 'exited' | 'error'>('connecting')
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    const parent = host.current
    if (!parent) return

    const tokens = readTokens(document.documentElement)
    const terminal = new Terminal({
      fontFamily: tokens.fontFamily,
      fontSize: 13,
      // Blinking cursors continuously redraw canvas even when the panel is open but unused.
      cursorBlink: false,
      convertEol: false,
      scrollback: 5000,
      theme: tokens.theme,
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(parent)

    fit.current = fitAddon

    const socket = new WebSocket(
      `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}` +
        `/api/projects/${projectId}/terminal?terminalId=${encodeURIComponent(terminalId)}`,
    )

    const send = (payload: TerminalClientMessage) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload))
    }

    const pushSize = () => {
      if (!shown.current) return
      fitAddon.fit()
      send({ t: 'resize', cols: terminal.cols, rows: terminal.rows })
    }

    socket.onmessage = (event) => {
      const payload = JSON.parse(String(event.data)) as TerminalServerMessage
      if (payload.t === 'ready') {
        terminal.write(payload.replay)
        setStatus(payload.exited ? 'exited' : 'ready')
        pushSize()
      } else if (payload.t === 'output') {
        terminal.write(payload.data)
      } else if (payload.t === 'exit') {
        setStatus('exited')
        setMessage(translate('terminal.shell.exited', { code: payload.code }))
      } else {
        setStatus('error')
        setMessage(payload.message)
      }
    }

    socket.onerror = () => {
      setStatus('error')
      setMessage('Connexion au terminal impossible.')
    }

    const typed = terminal.onData((data) => send({ t: 'input', data }))

    /** Return false to prevent xterm sending the key to the PTY. */
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown' || !event.ctrlKey) return true

      const key = event.key.toLowerCase()
      if (event.shiftKey && key === 'c') {
        const selection = terminal.getSelection()
        if (selection) {
          copyText(selection)
          terminal.focus()
        }
        return false
      }
      /**
       * Ctrl+V and Ctrl+Shift+V return control to the browser without preventDefault. Native paste
       * reaches xterm's textarea and PTY, working over HTTP without readText. Deliberately
       * sacrifice literal shell Ctrl+V (0x16) for universal paste behavior.
       */
      if (key === 'v') return false
      return true
    })

    /** Copy automatically on selection like PuTTY. */
    const onMouseUp = () => {
      const selection = terminal.getSelection()
      if (selection) {
        copyText(selection)
        terminal.focus()
      }
    }
    parent.addEventListener('mouseup', onMouseUp)

    /**
     * Right-click pastes like Windows terminals or PuTTY. Without navigator.clipboard, retain the
     * browser menu instead of swallowing clicks without action.
     */
    const onContextMenu = (event: MouseEvent) => {
      if (!navigator.clipboard) return
      event.preventDefault()
      void navigator.clipboard.readText().then((text) => send({ t: 'input', data: text }))
    }
    parent.addEventListener('contextmenu', onContextMenu)

    let timer: number | null = null
    const observer = new ResizeObserver(() => {
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(pushSize, RESIZE_DEBOUNCE_MS)
    })
    observer.observe(parent)

    return () => {
      if (timer !== null) window.clearTimeout(timer)
      observer.disconnect()
      parent.removeEventListener('mouseup', onMouseUp)
      parent.removeEventListener('contextmenu', onContextMenu)
      typed.dispose()
      // Sockets closed before connection later emit error: detach handlers or StrictMode/unmounted
      // sockets can overwrite successor state with connection failure.
      socket.onmessage = null
      socket.onerror = null
      socket.close()
      terminal.dispose()
      fit.current = null
    }
    // Deliberately exclude visible from dependencies: otherwise tab switches rebuild terminals and
    // clear shell screens. shown holds current visibility.
  }, [projectId, terminalId])

  /**
   * Becoming visible finally permits size measurement: hidden containers have zero width and
   * FitAddon returns no dimensions.
   */
  useEffect(() => {
    if (visible) fit.current?.fit()
  }, [visible])

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      {message ? (
        <p
          className={cx(
            'shrink-0 border-b px-2.5 py-1.5 text-[0.6875rem]',
            status === 'error'
              ? 'border-critical/40 bg-critical/12 text-critical'
              : 'border-line bg-surface-high text-ink-faint',
          )}
        >
          {message}
        </p>
      ) : null}

      {/* sg-terminal restores text selection disabled by shell dragging; without it copying is impossible. */}
      <div ref={host} className="sg-terminal min-h-0 min-w-0 flex-1 bg-sunken p-1.5" />

      <p className="shrink-0 border-t border-line px-2.5 py-1 text-[0.625rem] text-ink-faint">
        {t('terminal.shortcuts')}
      </p>
    </div>
  )
}
