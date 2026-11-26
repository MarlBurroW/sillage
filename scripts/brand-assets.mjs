import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { renderSiteSocialImage } from './site-social-image.mjs'

const root = new URL('../', import.meta.url)
const target = (name) => fileURLToPath(new URL(name, root))
const symbol = await readFile(target('docs/brand/symbol.svg'), 'utf8')
const paths = [...symbol.matchAll(/<path d="([^"]+)"/g)].map((match) => `<path d="${match[1]}"/>`).join('')
if (paths.length === 0) throw new Error('Le symbole de référence ne contient aucun tracé.')

const browser = await chromium.launch({ chromiumSandbox: true })
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 })
  async function render(name, width, height, svg) {
    await page.setViewportSize({ width, height })
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:100vw;height:100vh}</style>${svg}`)
    await page.screenshot({ path: target(name), omitBackground: true })
  }

  for (const [name, size, rounded] of [
    ['icon-192.png', 192, true],
    ['icon-512.png', 512, true],
    ['icon-maskable-512.png', 512, false],
    ['apple-touch-icon.png', 180, false],
  ]) {
    // Central 64% frame fits inside 80% safe circle, including extremities. Tile uses
    // app indigo accent (hue 275, like favicon): on home screens, icon is the only
    // visual link to the interface.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <rect width="100" height="100" rx="${rounded ? 23 : 0}" fill="#535cda"/>
      <g transform="translate(18 18) scale(.64)" fill="white">${paths}</g>
    </svg>`
    await render(`apps/web/public/${name}`, size, size, svg)
  }

  // Desktop app follows macOS icon sizing: tile occupies 824 px of a 1024 square,
  // 185 px corners, transparent margin for Dock shadow. electron-builder derives
  // Mac .icns and Linux sizes from it.
  const desktop = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
    <rect x="100" y="100" width="824" height="824" rx="185" fill="#535cda"/>
    <g transform="translate(248.3 248.3) scale(5.2736)" fill="white">${paths}</g>
  </svg>`
  await render('apps/desktop/resources/icon.png', 1024, 1024, desktop)

  await renderSiteSocialImage(browser)
} finally {
  await browser.close()
}
