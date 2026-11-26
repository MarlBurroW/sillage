import { Radio, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useTranslate } from '../lib/i18n'
import { radioStartTimedOut, setRadioStatus, toggleRadio, useRadio, useRadioStation } from '../lib/radio'
import { IconButton, cx } from './ui'

const PLAYER_ORIGIN = 'https://www.youtube-nocookie.com'
/** Longer than a slow stream start: past it, the browser most likely wants a tap in the player. */
const START_GRACE_MS = 8000
/** YouTube player states, as its embed reports them. */
const PLAYING = 1
const PAUSED = 2

/**
 * Claude FM is sound only: the player runs out of sight, mounted by the shell so pages come and go
 * without cutting it. It shows itself only when the browser will not start sound without a tap
 * inside it (iOS, strict autoplay settings), and hides again once playing.
 *
 * State comes from the embed's postMessage protocol rather than YouTube's script, which would run
 * third-party code in Sillage's own origin.
 */
export function RadioPlayer() {
  const t = useTranslate()
  const status = useRadio()
  const on = status !== 'off'
  const { data: station, isError } = useRadioStation()
  const frame = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    if (!on || !station) return
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== PLAYER_ORIGIN || event.source !== frame.current?.contentWindow || typeof event.data !== 'string') return
      let message: { event?: string; info?: unknown }
      try { message = JSON.parse(event.data) as typeof message } catch { return }
      const state = message.event === 'onStateChange' ? message.info
        : message.event === 'infoDelivery' ? (message.info as { playerState?: unknown } | null)?.playerState
        : undefined
      if (state === PLAYING) setRadioStatus('playing')
      // Paused from the revealed player: keep it in view so the same tap can resume.
      else if (state === PAUSED) setRadioStatus('blocked')
    }
    window.addEventListener('message', onMessage)
    const grace = setTimeout(radioStartTimedOut, START_GRACE_MS)
    return () => { window.removeEventListener('message', onMessage); clearTimeout(grace) }
  }, [on, station])

  if (!on) return null
  const shown = status === 'blocked' || isError
  return (
    <section
      aria-label={t('radio.title')}
      aria-hidden={!shown}
      className={cx(
        'fixed z-40 overflow-hidden',
        shown
          ? 'surface top-[calc(env(safe-area-inset-top)+3.5rem)] right-2 w-72 rounded-lg border border-line shadow-lg md:top-auto md:right-auto md:bottom-3 md:left-[calc(var(--nav-rail-width,52px)+0.75rem)] md:w-80'
          // Out of sight but laid out at a real size: a zero-sized or detached player may not play.
          : 'pointer-events-none bottom-0 left-0 w-[200px] opacity-0',
      )}
      data-radio-player={shown ? 'shown' : 'hidden'}
    >
      {shown ? (
        <header className="flex items-center gap-1.5 py-0.5 pr-0.5 pl-2.5">
          <Radio size={14} className="shrink-0 text-accent" />
          <span className="min-w-0 flex-1 text-xs">{t(isError ? 'radio.error' : 'radio.blocked')}</span>
          <IconButton size="sm" label={t('radio.stop')} onClick={toggleRadio}><X size={14} /></IconButton>
        </header>
      ) : null}
      <div className="aspect-video bg-black">
        {station ? (
          <iframe
            key={station.videoId}
            ref={frame}
            tabIndex={shown ? undefined : -1}
            className="size-full"
            src={`${PLAYER_ORIGIN}/embed/${station.videoId}?autoplay=1&playsinline=1&rel=0&enablejsapi=1&origin=${encodeURIComponent(location.origin)}`}
            title={station.title ?? t('radio.title')}
            // Delegated so the click that switched the radio on also starts the sound.
            allow="autoplay; encrypted-media"
            referrerPolicy="strict-origin-when-cross-origin"
            // Asks the player to report its state; it answers with infoDelivery and onStateChange.
            onLoad={(event) => event.currentTarget.contentWindow?.postMessage(JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }), PLAYER_ORIGIN)}
          />
        ) : null}
      </div>
    </section>
  )
}
