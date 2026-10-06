import { readFile, copyFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

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
    // Le cadre central de 64 % tient dans le cercle sûr de 80 %, même aux extrémités.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <rect width="100" height="100" rx="${rounded ? 23 : 0}" fill="#436e69"/>
      <g transform="translate(18 18) scale(.64)" fill="white">${paths}</g>
    </svg>`
    await render(`apps/web/public/${name}`, size, size, svg)
  }

  // Un même visuel de partage évite de laisser l’ancienne marque sur le site.
  const og = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630">
    <rect width="1200" height="630" fill="#112b2a"/>
    <g transform="translate(85 145) scale(1.5)" fill="#a6d8cc">${paths}</g>
    <g font-family="Arial, sans-serif">
      <text x="278" y="260" fill="#ffffff" font-size="92" font-weight="700" letter-spacing="-3">sillage</text>
      <text x="96" y="373" fill="#dcece8" font-size="30">Plateforme de développement agentique self-hosted</text>
      <text x="96" y="426" fill="#a6c5bf" font-size="26">Claude Code, Codex et OpenCode dans une seule interface.</text>
      <text x="96" y="552" fill="#a6c5bf" font-size="22">github.com/MarlBurroW/sillage</text>
    </g>
  </svg>`
  await render('apps/web/public/og.png', 1200, 630, og)
  await copyFile(target('apps/web/public/og.png'), target('site/og.png'))
} finally {
  await browser.close()
}
