import { useEffect } from 'react'
import { Menu } from 'lucide-react'
import { useTranslate } from '../lib/i18n'
import { Tooltip } from './ui/Tooltip'

const chrome = window.sillageDesktop?.window

/** Keep window chrome outside route/loading boundaries, including first-run setup. */
export function DesktopTitleBar() {
  const t = useTranslate()
  useEffect(() => {
    if (!chrome) return
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d')
    if (!context) return
    const color = (value: string) => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = value
      context.fillRect(0, 0, 1, 1)
      return '#' + [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map((v) => v.toString(16).padStart(2, '0')).join('')
    }
    const sync = () => {
      const style = getComputedStyle(document.documentElement)
      // Chromium resolves our OKLCH theme; Electron's overlay accepts sRGB colors.
      void chrome.colors(color(style.getPropertyValue('--sg-canvas')), color(style.getPropertyValue('--sg-ink'))).catch(() => {})
    }
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style'] })
    return () => observer.disconnect()
  }, [])
  if (!chrome) return null
  return <div className="desktop-titlebar" data-platform={chrome.platform}>
    <div className="desktop-titlebar-content">
      {chrome.platform !== 'darwin' && <Tooltip label={t('desktop.window.menu')} side="bottom">
        <button type="button" className="desktop-titlebar-menu" aria-label={t('desktop.window.menu')} aria-haspopup="menu" onClick={() => { void chrome.menu().catch(() => {}) }}>
          <Menu size={15} aria-hidden="true" />
        </button>
      </Tooltip>}
      <span className="desktop-titlebar-name">Sillage</span>
    </div>
  </div>
}
