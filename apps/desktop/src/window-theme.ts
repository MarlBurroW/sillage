import { mkdirSync, readFileSync, writeFile, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DesktopStartupColors } from '@sillage/protocol'

/**
 * The interface's colours, kept between launches.
 *
 * The theme lives in the interface's local storage, which only the served page can read, and
 * the server takes seconds to start. Until then the window and its startup page would show
 * Sillage's default colours, then switch to the user's theme: a flash that hurts in the dark.
 * The interface reports its resolved colours whenever they change; the next launch paints with
 * them from the first frame.
 */
export interface WindowTheme extends DesktopStartupColors {
  /** `--sg-canvas`: window background, title bar and page background. */
  canvas: string
  /** `--sg-ink-soft`: title bar symbols and the startup page's status line. */
  inkSoft: string
}

/** Favicon colours, for a first launch or a system appearance the saved theme was not made for. */
const DEFAULTS: Record<'dark' | 'light', WindowTheme> = {
  dark: { canvas: '#0b0d1c', ink: '#e6e8f5', inkSoft: '#8f93ab', accent: '#8f9bff', dark: true, followsSystem: true },
  light: { canvas: '#f7f7fb', ink: '#23263b', inkSoft: '#5b5f78', accent: '#535cda', dark: false, followsSystem: true },
}

/** Sliders in the appearance settings send bursts: write once they settle. */
const WRITE_DELAY_MS = 600

const HEX = /^#[0-9a-f]{6}$/i

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value)
}

export function isStartupColors(value: unknown): value is DesktopStartupColors {
  if (typeof value !== 'object' || value === null) return false
  const { ink, accent, dark, followsSystem } = value as Record<string, unknown>
  return isHexColor(ink) && isHexColor(accent) && typeof dark === 'boolean' && typeof followsSystem === 'boolean'
}

function isWindowTheme(value: unknown): value is WindowTheme {
  if (!isStartupColors(value)) return false
  const { canvas, inkSoft } = value as unknown as Record<string, unknown>
  return isHexColor(canvas) && isHexColor(inkSoft)
}

export function windowThemeStore(file: string) {
  let saved: WindowTheme | null = null
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (isWindowTheme(parsed)) saved = parsed
  } catch {
    // First launch or an unreadable file: the defaults will do.
  }
  let timer: NodeJS.Timeout | null = null
  const serialize = () => `${JSON.stringify(saved, null, 2)}\n`

  return {
    /**
     * Colours to open a window with. A theme that follows the system was saved for one
     * appearance; if the system has switched since, its other half is unknown.
     */
    current(systemDark: boolean): WindowTheme {
      if (saved && (!saved.followsSystem || saved.dark === systemDark)) return saved
      return DEFAULTS[systemDark ? 'dark' : 'light']
    },
    remember(next: WindowTheme): void {
      if (saved && (Object.keys(next) as (keyof WindowTheme)[]).every((key) => saved?.[key] === next[key])) return
      saved = next
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        // Losing it only costs one launch in the default colours.
        try {
          mkdirSync(dirname(file), { recursive: true })
          writeFile(file, serialize(), () => {})
        } catch {
          // Nothing else to do.
        }
      }, WRITE_DELAY_MS)
      timer.unref()
    },
    /** On quit: a theme changed just before must not wait for a timer that will never fire. */
    flush(): void {
      if (!timer) return
      clearTimeout(timer)
      timer = null
      try {
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, serialize())
      } catch {
        // Same as a failed write above.
      }
    },
  }
}

export type WindowThemeStore = ReturnType<typeof windowThemeStore>
