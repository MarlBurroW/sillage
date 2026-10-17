import * as Dialog from '@radix-ui/react-dialog'
import { ChevronLeft, ChevronRight, Copy, Download, Maximize, RotateCw, X, ZoomIn, ZoomOut } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { useTranslate } from '../../lib/i18n'

export interface ViewerImage { src: string; alt: string }

export function ImageGallery({ images, className = 'max-h-80 rounded-md border border-line object-contain' }: { images: ViewerImage[]; className?: string }) {
  const t = useTranslate()
  const [selected, setSelected] = useState<number | null>(null)
  return <>
    {images.map((image, index) => <button key={index} type="button" className="max-w-full cursor-zoom-in" aria-label={t('image.open', { name: image.alt })} onClick={(event) => { event.currentTarget.focus(); setSelected(index) }}>
      <img src={image.src} alt={image.alt} loading="lazy" className={className} />
    </button>)}
    {selected !== null && <ImageViewer images={images} initialIndex={selected} onClose={() => setSelected(null)} />}
  </>
}

export function ImageViewer({ images, initialIndex, onClose }: { images: ViewerImage[]; initialIndex: number; onClose: () => void }) {
  const t = useTranslate()
  const [opener] = useState(() => document.activeElement)
  const [index, setIndex] = useState(initialIndex)
  const image = images[index]!
  return <Dialog.Root open onOpenChange={(open) => { if (!open) onClose() }}>
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-[80] bg-black/90" />
      <Dialog.Content onCloseAutoFocus={(event) => { event.preventDefault(); if (opener instanceof HTMLElement) opener.focus() }} aria-describedby={undefined} className="fixed inset-0 z-[81] flex h-dvh flex-col bg-surface text-ink outline-none" onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault()
          setIndex((value) => (value + (event.key === 'ArrowLeft' ? images.length - 1 : 1)) % images.length)
        }
      }}>
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <Dialog.Title className="min-w-0 flex-1 truncate text-sm">{image.alt || t('image.title')}</Dialog.Title>
          {images.length > 1 && <>
            <Action label={t('image.previous')} onClick={() => setIndex((index + images.length - 1) % images.length)}><ChevronLeft size={20} /></Action>
            <span className="text-xs tabular-nums">{index + 1} / {images.length}</span>
            <Action label={t('image.next')} onClick={() => setIndex((index + 1) % images.length)}><ChevronRight size={20} /></Action>
          </>}
          <Dialog.Close asChild><button type="button" className="rounded-md p-3 hover:bg-surface-high" aria-label={t('image.close')} title={t('image.close')}><X size={20} /></button></Dialog.Close>
        </div>
        <ImageCanvas key={index} image={image} />
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}

function Action({ label, onClick, children, disabled }: { label: string; onClick: () => void; children: ReactNode; disabled?: boolean }) {
  // Garder le focus pendant la copie permet de continuer à naviguer au clavier.
  return <button type="button" aria-label={label} title={label} aria-disabled={disabled || undefined} onClick={() => { if (!disabled) onClick() }} className="rounded-md p-3 hover:bg-surface-high focus-visible:outline-accent aria-disabled:opacity-40">{children}</button>
}

function ImageCanvas({ image }: { image: ViewerImage }) {
  const t = useTranslate()
  const img = useRef<HTMLImageElement>(null)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const [zoom, setZoom] = useState(1)
  const [angle, setAngle] = useState(0)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [dimensions, setDimensions] = useState('')
  const [status, setStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const scale = (factor: number) => setZoom((value) => Math.min(16, Math.max(0.1, value * factor)))
  const reset = () => { setZoom(1); setPan({ x: 0, y: 0 }); setAngle(0) }
  const blob = async () => {
    const response = await fetch(image.src)
    if (!response.ok) throw new Error('Image unavailable')
    return response.blob()
  }
  const download = async () => {
    setBusy(true)
    try {
      const data = await blob()
      const url = URL.createObjectURL(data)
      const link = document.createElement('a')
      const ext = data.type.split('/')[1]?.replace('jpeg', 'jpg').replace('svg+xml', 'svg') || 'png'
      const name = image.alt.split('/').pop() || 'image'
      link.download = /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(name) ? name : `image.${ext}`
      link.href = url
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
      setStatus(t('image.downloaded'))
    } catch { setStatus(t('image.downloadError')) } finally { setBusy(false) }
  }
  const copy = () => {
    // La promesse est passée immédiatement : Safari exige le geste utilisateur lors de write().
    setBusy(true)
    const png = async () => {
      const data = await blob()
      if (data.type === 'image/png') return data
      const bitmap = await createImageBitmap(data)
      try {
        const canvas = document.createElement('canvas')
        canvas.width = bitmap.width; canvas.height = bitmap.height
        canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
        return await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error('PNG')), 'image/png'))
      } finally { bitmap.close() }
    }
    try {
      navigator.clipboard.write([new ClipboardItem({ 'image/png': png() })])
        .then(() => setStatus(t('image.copied')), () => setStatus(t('image.copyError')))
        .finally(() => setBusy(false))
    } catch { setStatus(t('image.copyError')); setBusy(false) }
  }
  return <>
    <div className="relative flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden bg-black/80" onWheel={(event) => scale(event.deltaY < 0 ? 1.1 : 1 / 1.1)} onDoubleClick={() => { if (zoom === 1) scale(2); else reset() }}
      onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY }) }}
      onPointerMove={(event) => {
        const previous = pointers.current.get(event.pointerId)
        if (!previous) return
        const next = { x: event.clientX, y: event.clientY }
        const other = [...pointers.current.entries()].find(([id]) => id !== event.pointerId)?.[1]
        if (other) {
          const before = Math.hypot(previous.x - other.x, previous.y - other.y)
          if (before > 0) scale(Math.hypot(next.x - other.x, next.y - other.y) / before)
        } else setPan((value) => ({ x: value.x + next.x - previous.x, y: value.y + next.y - previous.y }))
        pointers.current.set(event.pointerId, next)
      }} onPointerUp={(event) => pointers.current.delete(event.pointerId)} onPointerCancel={(event) => pointers.current.delete(event.pointerId)}>
      {failed ? <p role="alert" className="p-4 text-white">{t('image.loadError')}</p> : <img ref={img} src={image.src} alt={image.alt} draggable={false} className="max-h-full max-w-full select-none object-contain" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom}) rotate(${angle}deg)`, cursor: zoom > 1 ? 'grab' : 'zoom-in' }} onLoad={(event) => setDimensions(`${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight}`)} onError={() => setFailed(true)} />}
    </div>
    <div className="flex flex-wrap items-center justify-center gap-1 border-t border-line p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]">
      <Action label={t('image.zoomOut')} onClick={() => scale(1 / 1.25)} disabled={zoom <= 0.1}><ZoomOut size={20} /></Action>
      <span className="w-12 text-center text-xs tabular-nums">{Math.round(zoom * 100)}%</span>
      <Action label={t('image.zoomIn')} onClick={() => scale(1.25)} disabled={zoom >= 16}><ZoomIn size={20} /></Action>
      <Action label={t('image.fit')} onClick={reset}><Maximize size={20} /></Action>
      <Action label={t('image.actual')} onClick={() => { if (img.current) { setZoom(img.current.naturalWidth / img.current.width); setPan({ x: 0, y: 0 }); setAngle(0) } }}>1:1</Action>
      <Action label={t('image.rotate')} onClick={() => setAngle((value) => value + 90)}><RotateCw size={20} /></Action>
      <Action label={t('image.copy')} onClick={copy} disabled={busy || failed || !navigator.clipboard?.write || typeof ClipboardItem === 'undefined'}><Copy size={20} /></Action>
      <Action label={t('image.download')} onClick={() => void download()} disabled={busy || failed}><Download size={20} /></Action>
      <span className="px-2 text-xs text-ink-soft">{dimensions}</span>
      <span role="status" className="w-full text-center text-xs text-ink-soft">{status || t('image.hint')}</span>
    </div>
  </>
}
