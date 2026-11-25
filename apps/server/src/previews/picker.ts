/**
 * Element picker injected into HTML pages of previews opened from Sillage (never public demo
 * links). Sillage's panel and the preview are different origins, so they talk by `postMessage`:
 * the panel starts the picker, the page highlights what the pointer hovers, and a click sends the
 * element's selector, text and HTML back to the frame's parent only.
 */
export const PICKER_PATH = '/__sillage/picker.js'

export const PICKER_SCRIPT = `(() => {
  if (window.__sillagePicker || window.parent === window) return
  window.__sillagePicker = true
  let parentOrigin = null
  let active = false
  let box = null
  let tag = null

  const esc = (value) => (window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/[^\\w-]/g, '\\\\$&'))
  // A selector short enough to read, precise enough to find the element again: ids end the walk.
  const selectorOf = (element) => {
    const parts = []
    for (let node = element; node && node.nodeType === 1 && parts.length < 6; node = node.parentElement) {
      if (node.id) { parts.unshift('#' + esc(node.id)); break }
      let part = node.localName
      const classes = [...node.classList].filter((name) => !/[:[\\]/]/.test(name)).slice(0, 2)
      if (classes.length) part += '.' + classes.map(esc).join('.')
      const parent = node.parentElement
      if (parent) {
        const same = [...parent.children].filter((child) => child.localName === node.localName)
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')'
      }
      parts.unshift(part)
      if (node.localName === 'body') break
    }
    return parts.join(' > ')
  }

  const paint = (element) => {
    if (!box) {
      box = document.createElement('div')
      box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #a855f7;background:rgba(168,85,247,.12);border-radius:2px;transition:all 60ms'
      tag = document.createElement('div')
      tag.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;font:12px/1.4 ui-monospace,monospace;color:#fff;background:#7e22ce;padding:2px 6px;border-radius:3px;white-space:nowrap'
      document.documentElement.append(box, tag)
    }
    const rect = element.getBoundingClientRect()
    Object.assign(box.style, { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px', display: 'block' })
    tag.textContent = selectorOf(element).split(' > ').pop() + '  ' + Math.round(rect.width) + '×' + Math.round(rect.height)
    Object.assign(tag.style, { left: Math.max(0, rect.left) + 'px', top: Math.max(0, rect.top - 22) + 'px', display: 'block' })
  }

  const stop = (notify) => {
    active = false
    if (box) box.style.display = 'none'
    if (tag) tag.style.display = 'none'
    document.documentElement.style.cursor = ''
    if (notify && parentOrigin) parent.postMessage({ type: 'sillage-picker-stopped' }, parentOrigin)
  }

  const send = (element) => {
    const rect = element.getBoundingClientRect()
    parent.postMessage({
      type: 'sillage-picked',
      selector: selectorOf(element),
      tag: element.localName,
      text: (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300),
      html: element.outerHTML.slice(0, 3000),
      truncated: element.outerHTML.length > 3000,
      path: location.pathname + location.search,
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      viewport: { width: innerWidth, height: innerHeight },
    }, parentOrigin)
  }

  const isOverlay = (target) => target === box || target === tag
  addEventListener('pointermove', (event) => {
    if (active && event.target instanceof Element && !isOverlay(event.target)) paint(event.target)
  }, true)
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
    addEventListener(type, (event) => { if (active) { event.preventDefault(); event.stopPropagation() } }, true)
  }
  addEventListener('click', (event) => {
    if (!active || !(event.target instanceof Element)) return
    event.preventDefault()
    event.stopPropagation()
    send(event.target)
    stop(false)
  }, true)
  addEventListener('keydown', (event) => { if (active && event.key === 'Escape') { event.preventDefault(); stop(true) } }, true)

  addEventListener('message', (event) => {
    if (event.source !== parent || !event.data || event.data.type !== 'sillage-picker') return
    parentOrigin = event.origin
    if (event.data.action === 'start') { active = true; document.documentElement.style.cursor = 'crosshair' }
    else stop(false)
  })
  // Tells the panel the page can pick: pages the proxy did not inject never answer.
  parent.postMessage({ type: 'sillage-picker-ready' }, '*')
})()
`

/** Script tag placed first in the page's head, before the app's own scripts. */
const TAG = `<script src="${PICKER_PATH}"></script>`

export function injectPicker(html: string): string {
  const head = /<head[^>]*>/i.exec(html)
  if (head) return html.slice(0, head.index + head[0].length) + TAG + html.slice(head.index + head[0].length)
  const doctype = /<!doctype[^>]*>/i.exec(html)
  if (doctype) return html.slice(0, doctype.index + doctype[0].length) + TAG + html.slice(doctype.index + doctype[0].length)
  return TAG + html
}
