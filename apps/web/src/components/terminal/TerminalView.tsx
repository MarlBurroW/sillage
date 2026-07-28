import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { Check, ClipboardPaste, Copy, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { TerminalServerMessage } from '@sillage/protocol'
import { useCopy } from '../../lib/clipboard'
import { translate, useTranslate } from '../../lib/i18n'
import { Button, cx } from '../ui'

/**
 * Vue terminal.
 *
 * Pas montée pour l'instant : la bascule Conversation / Terminal laissait croire à un
 * basculement entre l'interface web et le CLI, ce que ce n'est pas. Le composant attend
 * le panneau latéral d'outils (spec section 10), où le terminal cohabitera avec
 * l'explorateur de fichiers et l'historique des modifications. Le pty et sa socket,
 * eux, sont bien actifs côté serveur.
 *
 * Le copier-coller est le point qui rate d'habitude sur un terminal web, et il rate
 * pour deux raisons cumulées :
 *
 *   - `navigator.clipboard` n'existe pas hors contexte sécurisé, et Sillage tourne en
 *     `http://` sur le réseau local. Toute copie doit donc passer par le repli
 *     `execCommand`, et aucune lecture du presse-papiers n'est possible.
 *   - sur mobile, la saisie passe par une zone de texte cachée, sans geste de collage
 *     natif accessible.
 *
 * D'où deux boutons explicites plutôt qu'un raccourci clavier : la copie prend la
 * sélection, ou tout le tampon à défaut ; le collage ouvre une vraie zone de texte
 * dans laquelle le geste natif du système fonctionne, quel que soit l'appareil.
 */

/** Couleurs lues sur le thème courant : xterm veut des valeurs, pas des variables. */
function resolvePalette(probe: HTMLElement): Record<string, string> {
  const style = getComputedStyle(probe)
  const read = (property: string) => style.getPropertyValue(property).trim()

  return {
    background: read('--sg-sunken'),
    foreground: read('--sg-ink'),
    cursor: read('--sg-accent'),
    selectionBackground: read('--sg-accent-wash'),
  }
}

interface Connection {
  socket: WebSocket
  terminal: Terminal
}

export function TerminalView({ conversationId }: { conversationId: string }) {
  const host = useRef<HTMLDivElement>(null)
  const connection = useRef<Connection | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pasting, setPasting] = useState(false)
  const { state: copyState, copy } = useCopy()
  const t = useTranslate()

  useEffect(() => {
    const node = host.current
    if (!node) return

    const palette = resolvePalette(document.documentElement)
    const terminal = new Terminal({
      // Renderer DOM par défaut, sans addon canvas ni WebGL : le texte reste de vrais
      // nœuds du document, donc sélectionnable par le geste natif du système.
      fontFamily: getComputedStyle(document.body).getPropertyValue('--font-mono') || 'monospace',
      fontSize: 13,
      cursorBlink: true,
      // Assez pour relire la sortie d'une compilation sans peser sur la mémoire.
      scrollback: 5000,
      theme: palette,
    })

    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(node)
    fit.fit()

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(
      `${protocol}//${location.host}/api/conversations/${conversationId}/terminal`,
    )
    connection.current = { socket, terminal }

    const sendResize = () => {
      if (socket.readyState !== WebSocket.OPEN) return
      socket.send(JSON.stringify({ t: 'resize', cols: terminal.cols, rows: terminal.rows }))
    }

    socket.onopen = () => {
      setError(null)
      sendResize()
    }

    socket.onmessage = (event: MessageEvent<string>) => {
      const message = JSON.parse(event.data) as TerminalServerMessage
      if (message.t === 'ready') {
        // Le tampon rejoué repeint l'écran tel qu'il était : revenir sur la vue ne
        // doit pas donner un terminal vide alors que le shell tourne toujours.
        terminal.write(message.replay)
      } else if (message.t === 'output') {
        terminal.write(message.data)
      } else if (message.t === 'exit') {
        terminal.write(
          `\r\n\x1b[2m${translate('terminal.view.shellExited', { code: message.code })}\x1b[0m\r\n`,
        )
      } else {
        setError(message.message)
      }
    }

    socket.onerror = () => setError(translate('terminal.view.connectionFailed'))
    socket.onclose = (event) => {
      if (event.code === 4401) setError(translate('terminal.view.sessionExpired'))
      else if (event.code === 4404) setError(translate('terminal.view.conversationNotFound'))
    }

    const input = terminal.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ t: 'input', data }))
      }
    })

    // La taille suit le conteneur, pas la fenêtre : replier la sidebar change la
    // largeur disponible sans qu'aucun `resize` de fenêtre ne soit émis.
    const observer = new ResizeObserver(() => {
      fit.fit()
      sendResize()
    })
    observer.observe(node)

    return () => {
      observer.disconnect()
      input.dispose()
      socket.close()
      terminal.dispose()
      connection.current = null
    }
  }, [conversationId])

  /** Contenu du tampon, ligne à ligne, pour la copie quand rien n'est sélectionné. */
  const bufferText = (terminal: Terminal): string => {
    const buffer = terminal.buffer.active
    const lines: string[] = []
    for (let i = 0; i < buffer.length; i += 1) {
      lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
    }
    // Les lignes vides de fin ne sont que le reste de l'écran, pas du contenu.
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    return lines.join('\n')
  }

  const copyTerminal = () => {
    const terminal = connection.current?.terminal
    if (!terminal) return
    copy(terminal.getSelection() || bufferText(terminal))
  }

  const paste = (value: string) => {
    setPasting(false)
    const socket = connection.current?.socket
    if (!value || socket?.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify({ t: 'input', data: value }))
    connection.current?.terminal.focus()
  }

  /** Séquence brute envoyée au pty, pour les touches absentes d'un clavier tactile. */
  const sendKey = (sequence: string) => {
    const socket = connection.current?.socket
    if (socket?.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify({ t: 'input', data: sequence }))
    connection.current?.terminal.focus()
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-2 py-1.5">
        <Button size="sm" variant="ghost" onClick={copyTerminal}>
          {copyState === 'copied' ? <Check size={14} /> : <Copy size={14} />}
          {copyState === 'copied'
            ? t('terminal.view.copy.copied')
            : copyState === 'failed'
              ? t('terminal.view.copy.failed')
              : t('terminal.view.copy.action')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setPasting(true)}>
          <ClipboardPaste size={14} />
          {t('terminal.view.paste.action')}
        </Button>

        {error ? (
          <span className="min-w-0 flex-1 truncate text-right text-xs text-critical">{error}</span>
        ) : null}
      </div>

      {pasting ? <PastePanel onPaste={paste} onCancel={() => setPasting(false)} /> : null}

      {/* `sg-terminal` autorise la sélection native par-dessus la règle de xterm, qui
          l'interdit : c'est elle qui rend l'appui long inopérant sur téléphone. */}
      <div ref={host} className="sg-terminal min-h-0 flex-1 overflow-hidden bg-sunken p-1.5" />

      {/* Un clavier tactile n'a ni Échap, ni Tab, ni Ctrl : sans ces touches, on ne
          peut ni compléter un chemin ni interrompre une commande. */}
      <div className="flex shrink-0 gap-1 overflow-x-auto border-t border-line px-2 py-1.5 md:hidden">
        {[
          { label: t('terminal.view.key.escape'), sequence: '\x1b' },
          { label: 'Tab', sequence: '\t' },
          { label: 'Ctrl+C', sequence: '\x03' },
          { label: 'Ctrl+D', sequence: '\x04' },
          { label: '↑', sequence: '\x1b[A' },
          { label: '↓', sequence: '\x1b[B' },
          { label: '←', sequence: '\x1b[D' },
          { label: '→', sequence: '\x1b[C' },
        ].map((key) => (
          <button
            key={key.label}
            type="button"
            onClick={() => sendKey(key.sequence)}
            className={cx(
              'shrink-0 rounded-md border border-line bg-surface-high px-2.5 py-1.5',
              'font-mono text-xs text-ink-soft',
            )}
          >
            {key.label}
          </button>
        ))}
      </div>
    </div>
  )
}

/**
 * Zone de collage.
 *
 * Le presse-papiers ne se lit pas hors contexte sécurisé : la seule façon fiable de
 * récupérer son contenu est que l'utilisateur y colle lui-même, avec le geste natif
 * de son système, dans un vrai champ de saisie.
 */
function PastePanel({
  onPaste,
  onCancel,
}: {
  onPaste: (value: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState('')
  const t = useTranslate()

  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-b border-line bg-surface p-2">
      <p className="text-xs text-ink-faint">{t('terminal.view.paste.hint')}</p>
      <textarea
        autoFocus
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            onPaste(value)
          }
          if (event.key === 'Escape') onCancel()
        }}
        rows={2}
        className={cx(
          'w-full resize-none rounded-md border border-line bg-sunken px-2 py-1.5',
          'font-mono text-xs text-ink outline-none focus:border-accent',
        )}
      />
      <div className="flex gap-1.5">
        <Button size="sm" disabled={!value} onClick={() => onPaste(value)}>
          {t('terminal.view.paste.send')}
        </Button>
        <Button size="sm" variant="ghost" icon={<X size={14} />} onClick={onCancel}>
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  )
}
