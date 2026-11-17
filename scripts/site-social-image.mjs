import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = new URL('../', import.meta.url)

/** Render the site's social card from the same local brand and product assets. */
export async function renderSiteSocialImage(browser) {
  const [symbol, font, screenshot] = await Promise.all([
    readFile(new URL('docs/brand/symbol.svg', root), 'utf8'),
    readFile(new URL('site/fonts/archivo-latin.woff2', root)),
    readFile(new URL('site/screenshots/hero-light.webp', root)),
  ])
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 })
  try {
    await page.setContent(`<!doctype html><html lang="en"><head><style>
      @font-face { font-family: Archivo; src: url(data:font/woff2;base64,${font.toString('base64')}); font-weight: 100 900; font-stretch: 62% 125%; }
      * { box-sizing: border-box; }
      body { margin: 0; width: 1200px; height: 630px; overflow: hidden; background: #f0f2f6; color: #0c1a2b; font-family: Archivo, sans-serif; }
      .brand { position: absolute; top: 52px; left: 64px; display: flex; align-items: center; gap: 12px; font-size: 30px; font-weight: 680; font-stretch: 112%; letter-spacing: -0.9px; }
      .brand svg { width: 42px; height: 42px; color: #3b4bdb; }
      h1 { position: absolute; left: 64px; top: 150px; width: 1010px; margin: 0; font-size: 67px; line-height: 1.03; letter-spacing: -1.9px; font-weight: 620; font-stretch: 114%; }
      p { position: absolute; left: 64px; bottom: 54px; margin: 0; font-size: 24px; color: #47566b; }
      .product { position: absolute; top: 392px; left: 640px; width: 760px; background: #fff; border: 1px solid #d3d9e3; border-radius: 10px; box-shadow: 0 24px 60px -18px #0c1a2b40; overflow: hidden; }
      .product img { display: block; width: 100%; }
    </style></head><body>
      <div class="brand">${symbol}<span>Sillage</span></div>
      <h1>One workspace for Claude Code, Codex, OpenCode, Grok Build and Antigravity.</h1>
      <p>Self-hosted and open source</p>
      <div class="product"><img src="data:image/webp;base64,${screenshot.toString('base64')}" alt=""></div>
    </body></html>`)
    await page.evaluate(() => document.fonts.ready)
    await page.locator('.product img').evaluate((image) => image.decode())
    await page.screenshot({ path: fileURLToPath(new URL('site/og.png', root)) })
  } finally {
    await page.close()
  }
}

const posterThemes = {
  light: { paper: '#f0f2f6', ink: '#0c1a2b', line: '#d3d9e3', wake: '#3b4bdb', foam: '#dfe4fb', shadow: '#0c1a2b40' },
  dark: { paper: '#0a1220', ink: '#e9eef6', line: '#223049', wake: '#98a3ff', foam: '#1a2548', shadow: '#000c' },
}

// Still rows of water with one V-shaped wake, the site's motif, as SVG paths.
function posterWater(theme) {
  const tip = { x: 1500, y: 250 }
  const calm = []
  const stirred = []
  for (let rowY = 60; rowY < 1080; rowY += 20) {
    let previous = null
    for (let x = 0; x <= 1920; x += 10) {
      const behind = tip.x - x
      // Distance to the nearer arm of a V that opens at about 20 degrees.
      const arm = Math.abs(rowY - tip.y) - behind * 0.36
      // The envelope, not the height, decides the colour: a wave keeps it through its zero crossings.
      const height = behind > 0 ? 9 * Math.exp(-((arm / 30) ** 2)) * Math.min(1, behind / 90) * Math.exp(-behind / 1500) : 0
      const point = { x, y: rowY + height * Math.cos(arm / 11), lift: height }
      if (previous) {
        const segment = `M${previous.x} ${previous.y.toFixed(1)}L${point.x} ${point.y.toFixed(1)}`
        if (Math.max(previous.lift, point.lift) > 0.9) stirred.push(segment)
        else calm.push(segment)
      }
      previous = point
    }
  }
  return `<path d="${calm.join('')}" stroke="${theme.ink}" stroke-opacity=".08" stroke-width="1.5"/><path d="${stirred.join('')}" stroke="${theme.wake}" stroke-opacity=".7" stroke-width="2" stroke-linecap="round"/>`
}

/**
 * Render the film's still for the home page, one per theme: the brand on its
 * water with the real desktop and phone captures the film is about.
 */
export async function renderFilmPosters(browser) {
  const [symbol, font] = await Promise.all([
    readFile(new URL('docs/brand/symbol.svg', root), 'utf8'),
    readFile(new URL('site/fonts/archivo-latin.woff2', root)),
  ])
  for (const [name, theme] of Object.entries(posterThemes)) {
    const [desktop, phone] = await Promise.all([
      readFile(new URL(`site/screenshots/hero-2x-${name}.webp`, root)),
      readFile(new URL(`site/screenshots/hero-mobile-2x-${name}.webp`, root)),
    ])
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })
    try {
      await page.setContent(`<!doctype html><html lang="en"><head><style>
        @font-face { font-family: Archivo; src: url(data:font/woff2;base64,${font.toString('base64')}); font-weight: 100 900; font-stretch: 62% 125%; }
        body { margin: 0; width: 1920px; height: 1080px; overflow: hidden; background: radial-gradient(60% 80% at 80% 30%, ${theme.foam}, ${theme.paper} 75%); color: ${theme.ink}; font-family: Archivo, sans-serif; }
        .water { position: absolute; inset: 0; }
        .brand { position: absolute; left: 120px; top: 150px; display: flex; align-items: center; gap: 30px; font-size: 150px; font-weight: 640; font-stretch: 114%; letter-spacing: -5px; }
        .brand svg { width: 150px; height: 150px; color: ${theme.wake}; }
        .shot { position: absolute; border: 1px solid ${theme.line}; border-radius: 14px; overflow: hidden; box-shadow: 0 40px 90px -30px ${theme.shadow}; }
        .shot img { display: block; width: 100%; }
        .desktop { left: 120px; top: 470px; width: 1250px; }
        .phone { left: 1440px; top: 360px; width: 330px; border-radius: 22px; }
      </style></head><body>
        <svg class="water" viewBox="0 0 1920 1080" fill="none" aria-hidden="true">${posterWater(theme)}</svg>
        <div class="brand">${symbol}<span>Sillage</span></div>
        <div class="shot desktop"><img src="data:image/webp;base64,${desktop.toString('base64')}" alt=""></div>
        <div class="shot phone"><img src="data:image/webp;base64,${phone.toString('base64')}" alt=""></div>
      </body></html>`)
      await page.evaluate(() => document.fonts.ready)
      await page.evaluate(() => Promise.all([...document.images].map((image) => image.decode())))
      await page.screenshot({ path: fileURLToPath(new URL(`site/film/poster-${name}.jpg`, root)), type: 'jpeg', quality: 86 })
    } finally {
      await page.close()
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const browser = await chromium.launch({ chromiumSandbox: true })
  try {
    await renderSiteSocialImage(browser)
    await renderFilmPosters(browser)
  } finally {
    await browser.close()
  }
}
