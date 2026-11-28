import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useMatch } from 'react-router-dom'
import { ArrowLeft, ArrowRight, Search } from 'lucide-react'
import { useTranslate } from '../lib/i18n'
import { PALETTE_SHORTCUT } from '../lib/palette'
import { useProjects } from '../lib/projects'
import { Logo } from './Logo'
import { Tooltip } from './ui/Tooltip'

const chrome = window.sillageDesktop?.window
/** Where the interface shell puts the search field: the bar mounts outside the router and the palette. */
const SEARCH_SLOT = 'desktop-titlebar-search'

/** The Navigation API, which Chromium has and TypeScript's DOM types do not yet. */
type NavigationHistory = EventTarget & { canGoBack: boolean; canGoForward: boolean }
const navigation = (window as Window & { navigation?: NavigationHistory }).navigation

/** Whether the window's history leads anywhere, kept current as the interface navigates. */
function useHistoryEnds() {
  const read = () => ({ back: navigation?.canGoBack ?? true, forward: navigation?.canGoForward ?? true })
  const [ends, setEnds] = useState(read)
  useEffect(() => {
    if (!navigation) return
    const update = () => setEnds(read)
    navigation.addEventListener('currententrychange', update)
    return () => navigation.removeEventListener('currententrychange', update)
  }, [])
  return ends
}

/**
 * Sillage Desktop's title bar, kept outside route and loading boundaries, first-run setup included.
 * In the rail's colour and without a rule above it, so that bar and rail frame the page together;
 * native controls sit in Electron's overlay at the end (or the start, on macOS).
 */
export function DesktopTitleBar() {
  const t = useTranslate()
  const ends = useHistoryEnds()
  useEffect(() => {
    if (!chrome) return
    const root = document.documentElement
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
      const style = getComputedStyle(root)
      // Chromium resolves our OKLCH theme; Electron's overlay accepts sRGB colors.
      void chrome.colors(color(style.getPropertyValue('--sg-canvas')), color(style.getPropertyValue('--sg-ink-soft'))).catch(() => {})
    }
    // The controls take the bar's height in window pixels, which zoom changes.
    let height = 0
    const fit = () => {
      const bar = document.querySelector('.desktop-titlebar')?.getBoundingClientRect().height ?? 0
      if (bar === 0 || bar === height) return
      height = bar
      void chrome.layout(bar).catch(() => {})
    }
    sync()
    fit()
    const observer = new MutationObserver(sync)
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme', 'style'] })
    window.addEventListener('resize', fit)

    // Back and forward as in a browser: Alt+arrows, or ⌘[ and ⌘] on macOS.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return
      const mac = chrome.platform === 'darwin'
      const back = mac ? event.metaKey && event.key === '[' : event.altKey && !event.ctrlKey && !event.metaKey && event.key === 'ArrowLeft'
      const forward = mac ? event.metaKey && event.key === ']' : event.altKey && !event.ctrlKey && !event.metaKey && event.key === 'ArrowRight'
      if (!back && !forward) return
      event.preventDefault()
      if (back) history.back()
      else history.forward()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', fit)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [])
  if (!chrome) return null
  const mac = chrome.platform === 'darwin'
  return <div className="desktop-titlebar" data-platform={chrome.platform}>
    <div className="desktop-titlebar-content">
      <div className="desktop-titlebar-start">
        {/* Over the rail, in its place: the mark opens the menu the window no longer shows. macOS has its own menu bar. */}
        {mac ? null : <Tooltip label={t('desktop.window.menu')} side="bottom">
          <button type="button" className="desktop-titlebar-brand" aria-label={t('desktop.window.menu')} aria-haspopup="menu" onClick={(event) => {
            // Drops from under the mark, like a menu bar's, wherever the pointer was.
            const { left, bottom } = event.currentTarget.getBoundingClientRect()
            void chrome.menu({ x: left, y: bottom }).catch(() => {})
          }}>
            <Logo size={17} className="text-accent" />
          </button>
        </Tooltip>}
        <Tooltip label={`${t('desktop.window.back')} (${mac ? '⌘[' : 'Alt+←'})`} side="bottom">
          <button type="button" className="desktop-titlebar-button" aria-label={t('desktop.window.back')} disabled={!ends.back} onClick={() => history.back()}>
            <ArrowLeft size={15} aria-hidden="true" />
          </button>
        </Tooltip>
        <Tooltip label={`${t('desktop.window.forward')} (${mac ? '⌘]' : 'Alt+→'})`} side="bottom">
          <button type="button" className="desktop-titlebar-button" aria-label={t('desktop.window.forward')} disabled={!ends.forward} onClick={() => history.forward()}>
            <ArrowRight size={15} aria-hidden="true" />
          </button>
        </Tooltip>
      </div>
      <div id={SEARCH_SLOT} className="desktop-titlebar-center" />
    </div>
  </div>
}

/**
 * The bar's search field, rendered by the interface shell, which knows the open project and owns
 * the palette. Reads like the palette it opens: scoped to the project shown, if any.
 */
export function DesktopTitleSearch({ onOpen }: { onOpen: () => void }) {
  const t = useTranslate()
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  useEffect(() => setSlot(document.getElementById(SEARCH_SLOT)), [])
  const projectId = useMatch('/p/:projectId/*')?.params.projectId
  const { data: projects } = useProjects()
  const project = projectId ? projects?.find((entry) => entry.id === projectId) : undefined
  if (!slot) return null
  const label = project ? t('search.placeholder.scoped', { name: project.name }) : t('shell.search')
  return createPortal(
    <button type="button" className="desktop-titlebar-search" aria-keyshortcuts="Control+K Meta+K" onClick={onOpen}>
      <Search size={13} aria-hidden="true" />
      <span className="desktop-titlebar-search-label">{label}</span>
      <kbd>{PALETTE_SHORTCUT}</kbd>
    </button>,
    slot,
  )
}
