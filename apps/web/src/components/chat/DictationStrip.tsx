import { TooltipButton } from '../ui/Tooltip'
import { Square } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../lib/i18n'
import { cx } from '../ui'

/**
 * Replace input during dictation with timer and real microphone-level bars. This is a meter rather
 * than decoration: flat bars while speaking reveal wrong-device capture and a silence warning
 * explains it.
 */

const BAR_COUNT = 36
/** Bar scrolling cadence; measure audio level every frame. */
const BAR_INTERVAL_MS = 90
/** Below this threshold treat capture as voiceless; noise floor is approximately 0.001. */
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
      // Peak since the previous bar rather than average so brief syllables remain visible.
      peak = Math.max(peak, Math.sqrt(sum / samples.length))

      const now = performance.now()
      if (now - last >= BAR_INTERVAL_MS) {
        last = now
        if (peak >= HEARD_RMS) heard.current = true
        // Square-root scaling: normal speech peaks around RMS 0.1 and linear bars would stay flat
        // even when loud. Capture before updating because the render-time updater would otherwise
        // read the reset peak.
        const level = Math.min(1, Math.sqrt(peak) * 2.2)
        setBars((current) => [...current.slice(1), level])
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

      <TooltipButton
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
      </TooltipButton>
    </div>
  )
}
