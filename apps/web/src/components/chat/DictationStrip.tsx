import { Square } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../lib/i18n'
import { cx } from '../ui'

/**
 * Bande affichée à la place du champ de saisie pendant une dictée : chrono, et des
 * barres dont la hauteur suit le niveau réel du micro. Le but n'est pas décoratif,
 * c'est un vumètre : des barres à plat pendant qu'on parle disent que le navigateur
 * écoute le mauvais périphérique, et l'alerte silence le dit en toutes lettres.
 */

const BAR_COUNT = 36
/** Cadence de défilement des barres. Le niveau, lui, est relevé à chaque frame. */
const BAR_INTERVAL_MS = 90
/** En dessous, on considère qu'aucune voix n'est captée (le fond de bruit est ~0.001). */
const HEARD_RMS = 0.02
const SILENCE_WARNING_MS = 3000

export function DictationStrip({
  analyser,
  onStop,
}: {
  analyser: AnalyserNode
  onStop: () => void
}) {
  const t = useTranslate()
  const [bars, setBars] = useState<number[]>(() => Array<number>(BAR_COUNT).fill(0))
  const [silent, setSilent] = useState(false)
  const [seconds, setSeconds] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => setSeconds((value) => value + 1), 1000)
    return () => clearInterval(timer)
  }, [])

  const heard = useRef(false)
  useEffect(() => {
    const samples = new Uint8Array(analyser.fftSize)
    const started = performance.now()
    let last = started
    let peak = 0
    let frame = 0

    const tick = () => {
      analyser.getByteTimeDomainData(samples)
      let sum = 0
      for (const sample of samples) {
        const value = (sample - 128) / 128
        sum += value * value
      }
      // Le pic depuis la dernière barre, pas la moyenne : une syllabe brève entre deux
      // rafraîchissements doit se voir.
      peak = Math.max(peak, Math.sqrt(sum / samples.length))

      const now = performance.now()
      if (now - last >= BAR_INTERVAL_MS) {
        last = now
        if (peak >= HEARD_RMS) heard.current = true
        setBars((current) => [...current.slice(1), Math.min(1, peak * 3)])
        setSilent(!heard.current && now - started >= SILENCE_WARNING_MS)
        peak = 0
      }
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [analyser])

  return (
    <div
      role="status"
      aria-label={t('composer.dictate.recording')}
      className="flex min-h-[44px] items-center gap-3 px-2 py-1.5"
    >
      <span className="size-2 shrink-0 animate-pulse rounded-full bg-critical" />
      <span className="shrink-0 text-xs text-ink-soft tabular-nums">
        {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
      </span>

      {silent ? (
        <p className="flex-1 truncate text-xs text-caution">{t('composer.dictate.silent')}</p>
      ) : (
        <div aria-hidden className="flex h-8 flex-1 items-center gap-[3px] overflow-hidden">
          {bars.map((level, index) => (
            <div
              key={index}
              className={cx(
                'w-[3px] shrink-0 rounded-full transition-[height] duration-75',
                level > 0.04 ? 'bg-accent' : 'bg-line-strong',
              )}
              style={{ height: `${Math.max(12, level * 100)}%` }}
            />
          ))}
        </div>
      )}

      <button
        type="button"
        onClick={onStop}
        aria-label={t('composer.dictate.stop')}
        title={t('composer.dictate.stop')}
        className={cx(
          'flex size-9 shrink-0 items-center justify-center rounded-full',
          'bg-critical/12 text-critical transition-colors hover:bg-critical/20',
        )}
      >
        <Square size={13} fill="currentColor" />
      </button>
    </div>
  )
}
