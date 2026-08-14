import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { useEffect, useRef, useState } from 'react'
import type { TerminalClientMessage, TerminalServerMessage } from '@sillage/protocol'
import { cx } from '../ui'
import '@xterm/xterm/css/xterm.css'
import { translate, useTranslate } from '../../lib/i18n'

/**
 * Un terminal, relié à son pty par la socket dédiée.
 *
 * **Le copier/coller est le point qui décide si un shell web est utilisable**, et c'est
 * précisément ce qui ne marche pas ailleurs. `Ctrl+C` doit rester `SIGINT` : c'est la
 * seule façon d'arrêter une commande, et la remplacer par « copier » rendrait le
 * terminal inutilisable. La copie se fait donc à la sélection, comme dans PuTTY, avec
 * `Ctrl+Shift+C` en geste explicite ; le collage par `Ctrl+V` et par le clic droit.
 *
 * La contrainte qui a tout dicté : l'instance s'ouvre aussi par son adresse LAN en
 * HTTP, où `navigator.clipboard` n'existe pas (contexte non sécurisé). Chaque geste a
 * donc un chemin qui ne dépend pas de cette API.
 */

/** Le pty vit côté serveur : sa taille suit la vue, mais pas à chaque pixel du geste. */
const RESIZE_DEBOUNCE_MS = 120

/**
 * Jetons de l'application, **résolus** avant d'être passés à xterm.
 *
 * Un `var(--...)` ne peut pas traverser : xterm mesure la cellule en écrivant la
 * police dans un contexte de mesure, où la fonction `var()` n'existe pas. La mesure
 * échoue alors en silence, `FitAddon` refuse de proposer des dimensions, et le
 * terminal reste figé à sa taille de départ quelle que soit la largeur disponible.
 */
/**
 * Écrit dans le presse-papiers, y compris hors contexte sécurisé.
 *
 * Le repli passe par un textarea hors écran et `execCommand('copy')`, qui reste le
 * seul chemin en HTTP et fonctionne tant qu'on est dans un geste utilisateur. Il vole
 * le focus le temps de la copie : l'appelant doit le rendre au terminal.
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
  /** Change quand l'onglet devient visible : xterm ne peut pas se dimensionner caché. */
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
   * Visibilité courante, dans une ref plutôt que lue depuis la fermeture de l'effet.
   *
   * Le terminal se monte pendant le rendu où la sélection d'onglet n'est pas encore
   * faite, donc avec `visible` à faux. Capturé, ce faux ne changeait plus jamais : le
   * redimensionnement sortait en silence, et le terminal restait figé à sa largeur de
   * départ quelle que soit la place disponible.
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
      // Un curseur qui clignote redessine le canevas en continu, y compris quand le
      // panneau est ouvert et qu'on ne s'en sert pas.
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

    /** Renvoie faux pour que xterm n'envoie pas la touche au pty. */
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
       * `Ctrl+V` (et `Ctrl+Shift+V`) : rendre la main au navigateur sans
       * `preventDefault`. Son collage natif atteint le textarea de xterm, qui
       * transmet au pty ; c'est le seul chemin qui marche aussi en HTTP, où
       * `readText` n'existe pas. Le `Ctrl+V` littéral (0x16) des shells se perd,
       * compromis assumé pour que le geste universel colle.
       */
      if (key === 'v') return false
      return true
    })

    /** La sélection copie d'elle-même, comme dans PuTTY. */
    const onMouseUp = () => {
      const selection = terminal.getSelection()
      if (selection) {
        copyText(selection)
        terminal.focus()
      }
    }
    parent.addEventListener('mouseup', onMouseUp)

    /**
     * Le clic droit colle, comme dans un terminal Windows ou un PuTTY. Sans
     * `navigator.clipboard`, on laisse venir le menu du navigateur plutôt que
     * d'avaler le clic sans rien faire.
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
      socket.close()
      terminal.dispose()
      fit.current = null
    }
    // `visible` est délibérément hors des dépendances : le mettre reconstruirait le
    // terminal à chaque bascule d'onglet, et le shell repartirait d'un écran vide.
    // C'est `shown` qui en porte la valeur courante.
  }, [projectId, terminalId])

  /**
   * Devenir visible est le seul moment où la taille peut enfin être mesurée : dans un
   * conteneur masqué, la largeur vaut zéro et `FitAddon` ne propose rien.
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

      {/* `sg-terminal` rétablit la sélection de texte, que la coque désactive pendant
          les gestes de glissement : sans elle, on ne peut rien copier. */}
      <div ref={host} className="sg-terminal min-h-0 min-w-0 flex-1 bg-sunken p-1.5" />

      <p className="shrink-0 border-t border-line px-2.5 py-1 text-[0.625rem] text-ink-faint">
        {t('terminal.shortcuts')}
      </p>
    </div>
  )
}
