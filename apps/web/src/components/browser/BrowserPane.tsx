import { ArrowLeft, ArrowRight, Globe, Hand, RotateCw, X } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from 'react'
import type { BrowserClientMessage } from '@sillage/protocol'
import { useBrowserLive, useCloseBrowser } from '../../lib/browsers'
import { useTranslate } from '../../lib/i18n'
import { PanelEmptyState } from '../panel/PanelEmptyState'
import { Banner, EmptyState, IconButton, Select, cx } from '../ui'

/** CDP modifier bits: Alt 1, Ctrl 2, Meta 4, Shift 8. */
function modifiersOf(event: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0)
}

const BUTTONS = ['left', 'middle', 'right'] as const

/**
 * A conversation's browser, live. Watching is passive; taking over forwards pointer, wheel and
 * keyboard to the page, for a login or a challenge the agent cannot pass, then hands back by
 * switching off. The agent keeps its own connection throughout.
 */
export function BrowserPane({ conversationId }: { conversationId: string }) {
  const t = useTranslate()
  const live = useBrowserLive(conversationId)
  const close = useCloseBrowser()
  const [control, setControl] = useState(false)
  const [address, setAddress] = useState('')
  const [editing, setEditing] = useState(false)
  const image = useRef<HTMLImageElement>(null)
  const surface = useRef<HTMLDivElement>(null)

  const tabs = live.browser?.tabs ?? []
  const current = tabs.find((tab) => tab.targetId === live.watching) ?? null

  // The address bar follows the page unless someone is typing in it.
  useEffect(() => {
    if (!editing) setAddress(current?.url ?? '')
  }, [current?.url, editing])

  useEffect(() => {
    if (control) surface.current?.focus()
  }, [control])

  // When the view appears, take the panel's initial focus (its close button, whose tooltip would
  // cover this toolbar), but never focus someone is using elsewhere, such as the composer.
  const shown = live.browser !== null
  useEffect(() => {
    const active = document.activeElement
    if (shown && (active === document.body || active?.hasAttribute('data-panel-initial-focus'))) surface.current?.focus({ preventScroll: true })
  }, [shown])

  if (!live.browser) {
    return (
      <PanelEmptyState>
        <EmptyState icon={<Globe size={22} />} title={t('browser.empty.title')} description={t('browser.empty.description')} />
      </PanelEmptyState>
    )
  }

  /** Pointer position in page CSS pixels, from the displayed (letterboxed) image. */
  const pagePoint = (event: { clientX: number; clientY: number }) => {
    const img = image.current
    if (!img || !live.frame) return null
    const box = img.getBoundingClientRect()
    const scale = Math.min(box.width / live.frame.width, box.height / live.frame.height)
    const left = box.left + (box.width - live.frame.width * scale) / 2
    const top = box.top + (box.height - live.frame.height * scale) / 2
    const x = (event.clientX - left) / scale
    const y = (event.clientY - top) / scale
    if (x < 0 || y < 0 || x > live.frame.width || y > live.frame.height) return null
    return { x, y }
  }

  const pointer = (type: 'mousePressed' | 'mouseReleased' | 'mouseMoved') => (event: PointerEvent<HTMLDivElement>) => {
    if (!control) return
    const point = pagePoint(event)
    if (!point) return
    // Moves only matter while a button is down (drags) or for hover menus; throttle the rest by
    // sending them without click counts.
    if (type === 'mouseMoved' && event.buttons === 0 && event.pointerType !== 'mouse') return
    event.preventDefault()
    const button = type === 'mouseMoved' ? (event.buttons === 0 ? 'none' : 'left') : BUTTONS[event.button] ?? 'left'
    live.send({ t: 'mouse', type, ...point, button, clickCount: type === 'mouseMoved' ? 0 : 1, modifiers: modifiersOf(event) })
  }

  const wheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!control) return
    const point = pagePoint(event)
    if (!point) return
    live.send({ t: 'wheel', ...point, deltaX: event.deltaX, deltaY: event.deltaY, modifiers: modifiersOf(event) })
  }

  const key = (type: 'keyDown' | 'keyUp') => (event: KeyboardEvent<HTMLDivElement>) => {
    if (!control) return
    // Leave the browser's own shortcuts alone except those that edit text.
    if ((event.metaKey || event.ctrlKey) && !['a', 'c', 'x', 'z', 'Backspace'].includes(event.key)) return
    // Pasting goes through the paste event, as text.
    if ((event.metaKey || event.ctrlKey) && event.key === 'v') return
    event.preventDefault()
    const printable = event.key.length === 1 && !event.ctrlKey && !event.metaKey
    const message: BrowserClientMessage = {
      t: 'key',
      type,
      key: event.key,
      code: event.code,
      keyCode: event.keyCode || undefined,
      modifiers: modifiersOf(event),
      ...(printable && type === 'keyDown' ? { text: event.key } : event.key === 'Enter' && type === 'keyDown' ? { text: '\r' } : {}),
    }
    live.send(message)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Two rows on every width: the panel is narrow, and a URL needs the full line to be read. */}
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-line px-2 py-1.5">
        <div className="flex items-center gap-1">
          <IconButton label={t('browser.back')} size="sm" onClick={() => live.send({ t: 'history', action: 'back' })}><ArrowLeft size={15} /></IconButton>
          <IconButton label={t('browser.forward')} size="sm" onClick={() => live.send({ t: 'history', action: 'forward' })}><ArrowRight size={15} /></IconButton>
          <IconButton label={t('browser.reload')} size="sm" onClick={() => live.send({ t: 'history', action: 'reload' })}><RotateCw size={14} /></IconButton>
          <span className="flex-1" />
          <IconButton
            label={control ? t('browser.release') : t('browser.takeOver')}
            size="sm"
            aria-pressed={control}
            className={cx(control && 'bg-accent/15 text-accent')}
            onClick={() => setControl((value) => !value)}
          >
            <Hand size={15} />
          </IconButton>
          <IconButton label={t('browser.close')} size="sm" disabled={close.isPending} onClick={() => close.mutate(conversationId)}><X size={15} /></IconButton>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (address.trim()) live.send({ t: 'navigate', url: address.trim() })
            setEditing(false)
            ;(event.currentTarget.elements.namedItem('address') as HTMLInputElement | null)?.blur()
          }}
        >
          <input
            name="address"
            aria-label={t('browser.address')}
            value={address}
            onFocus={() => setEditing(true)}
            onBlur={() => setEditing(false)}
            onChange={(event) => setAddress(event.target.value)}
            className="h-8 w-full min-w-0 rounded-md border border-line bg-sunken px-2 font-mono text-xs text-ink-soft focus:border-accent focus:outline-none"
          />
        </form>
      </div>

      {tabs.length > 1 ? (
        <div className="shrink-0 border-b border-line px-2 py-1.5">
          <Select<string>
            placeholder={t('browser.tabs')}
            value={live.watching ?? ''}
            onChange={(targetId) => live.send({ t: 'watch', targetId })}
            options={tabs.map((tab) => ({ value: tab.targetId, label: tab.title || tab.url, hint: tab.url }))}
          />
        </div>
      ) : null}

      {control ? <Banner tone="caution">{t('browser.control.banner')}</Banner> : null}
      {live.error ? <Banner tone="critical">{live.error}</Banner> : null}

      <div
        ref={surface}
        tabIndex={0}
        role="application"
        aria-label={t('browser.view', { title: current?.title || current?.url || '' })}
        data-browser-view
        className={cx('relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-sunken p-2 outline-none', control && 'ring-2 ring-inset ring-accent')}
        onPointerDown={pointer('mousePressed')}
        onPointerUp={pointer('mouseReleased')}
        onPointerMove={pointer('mouseMoved')}
        onWheel={wheel}
        onKeyDown={key('keyDown')}
        onKeyUp={key('keyUp')}
        onPaste={(event) => {
          if (!control) return
          event.preventDefault()
          const text = event.clipboardData.getData('text/plain')
          if (text) live.send({ t: 'text', text })
        }}
        onContextMenu={(event) => { if (control) event.preventDefault() }}
      >
        {live.frame ? (
          <img
            ref={image}
            src={live.frame.url}
            alt={current?.title ?? ''}
            draggable={false}
            className="max-h-full max-w-full select-none rounded-sm border border-line object-contain shadow-sm"
          />
        ) : (
          <p className="text-xs text-ink-faint">{t('browser.waitingFrame')}</p>
        )}
      </div>
      <p className="shrink-0 border-t border-line px-3 py-1.5 text-[11px] text-ink-faint">
        {live.browser.agentConnected ? t('browser.agentConnected') : t('browser.agentIdle')}
      </p>
    </div>
  )
}
