import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = new URL('../', import.meta.url)

const homeCard = {
  en: { title: 'One workspace for Claude Code, Codex, OpenCode, Grok Build, Antigravity and GitHub Copilot.', line: 'Self-hosted and open source', files: ['site/og.png', 'apps/web/public/og.png'] },
  // French runs longer: one size down keeps the headline on three lines, clear of the capture.
  fr: { title: 'Un espace de travail pour Claude Code, Codex, OpenCode, Grok Build, Antigravity et GitHub Copilot.', line: 'Auto-hébergé et open source', files: ['site/og/fr/home.png'], size: 52 },
}

/** Render the social card from the same local brand and product assets. The site and the app share the English one, so a link to either previews the same product. */
export async function renderSiteSocialImage(browser, language = 'en') {
  const card = homeCard[language]
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
      h1 { position: absolute; left: 64px; top: 150px; width: 1070px; margin: 0; font-size: ${card.size || 60}px; line-height: 1.04; letter-spacing: -1.7px; font-weight: 620; font-stretch: 114%; }
      p { position: absolute; left: 64px; bottom: 54px; margin: 0; font-size: 24px; color: #47566b; }
      .product { position: absolute; top: 392px; left: 640px; width: 760px; background: #fff; border: 1px solid #d3d9e3; border-radius: 10px; box-shadow: 0 24px 60px -18px #0c1a2b40; overflow: hidden; }
      .product img { display: block; width: 100%; }
    </style></head><body>
      <div class="brand">${symbol}<span>Sillage</span></div>
      <h1>${card.title}</h1>
      <p>${card.line}</p>
      <div class="product"><img src="data:image/webp;base64,${screenshot.toString('base64')}" alt=""></div>
    </body></html>`)
    await page.evaluate(() => document.fonts.ready)
    await page.locator('.product img').evaluate((image) => image.decode())
    const image = await page.screenshot()
    await Promise.all(card.files.map(async (path) => {
      await mkdir(dirname(fileURLToPath(new URL(path, root))), { recursive: true })
      await writeFile(fileURLToPath(new URL(path, root)), image)
    }))
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
 * water with the real desktop and phone captures the film is about. A copy of the
 * dark one with a play pill goes to `docs/images` for the README.
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
      // GitHub cannot play a repository video inline: the README shows the same still
      // with the play pill baked in, as a link to the film on the site. A themed
      // <picture> cannot sit inside a link there, so only the dark still is rendered.
      if (name === 'dark') {
        await page.evaluate((pill) => document.body.insertAdjacentHTML('beforeend', pill), `<div style="position: absolute; left: 124px; top: 338px; display: flex; align-items: center; gap: 18px; padding: 18px 34px 18px 22px; border-radius: 99px; background: ${theme.ink}; color: ${theme.paper}; font-size: 40px; font-weight: 600;">
          <svg viewBox="0 0 24 24" width="52" height="52" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><circle cx="12" cy="12" r="9.2"/><path d="m10 8.4 5.6 3.6-5.6 3.6z" fill="currentColor" stroke="none"/></svg>Watch the film · 54 s</div>`)
        await page.screenshot({ path: fileURLToPath(new URL('docs/images/film-poster.jpg', root)), type: 'jpeg', quality: 86 })
      }
    } finally {
      await page.close()
    }
  }
}

/** Pages whose links deserve their own card rather than the product one. Static text only: no count that would go stale. */
const pageCards = {
  en: [
    ['changelog', 'Changelog', 'Every release of Sillage, newest first, with its notes.'],
    ['docs', 'Documentation', 'Getting started, then the guides for Desktop, Server and your agents.'],
    ['security', 'Security and privacy', 'What stays on your machine, what leaves it, and how to report a problem.'],
    ['download', 'Download Sillage', 'The desktop app for macOS, Windows and Linux, or a server you control.'],
    ['features', 'Features', 'Everything Sillage does, with the editions each feature works in.'],
    ['agents', 'Agents', 'Claude Code, Codex, OpenCode, Grok Build, Antigravity and GitHub Copilot, each through its own CLI.'],
  ],
  fr: [
    ['changelog', 'Nouveautés', 'Chaque version de Sillage, de la plus récente à la plus ancienne, avec ses notes.'],
    ['docs', 'Documentation', 'Pour démarrer, puis les guides de Desktop, de Server et de tes agents.'],
    ['security', 'Sécurité et confidentialité', 'Ce qui reste sur ta machine, ce qui en sort, et comment signaler un problème.'],
    ['download', 'Télécharger Sillage', 'L’app de bureau pour macOS, Windows et Linux, ou un serveur que tu contrôles.'],
    ['features', 'Fonctionnalités', 'Tout ce que fait Sillage, avec les éditions où chaque fonctionnalité marche.'],
    ['agents', 'Agents', 'Claude Code, Codex, OpenCode, Grok Build, Antigravity et GitHub Copilot, chacun par son propre CLI.'],
  ],
}

/** Render a card per page in `site/og/` (`site/og/<lang>/` for a translation): the brand, the page's title and the water with its wake. */
export async function renderPageCards(browser, language = 'en') {
  const folder = language === 'en' ? 'site/og/' : `site/og/${language}/`
  await mkdir(fileURLToPath(new URL(folder, root)), { recursive: true })
  const [symbol, font] = await Promise.all([
    readFile(new URL('docs/brand/symbol.svg', root), 'utf8'),
    readFile(new URL('site/fonts/archivo-latin.woff2', root)),
  ])
  const theme = posterThemes.light
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 })
  try {
    for (const [name, title, line] of pageCards[language]) {
      await page.setContent(`<!doctype html><html lang="en"><head><style>
        @font-face { font-family: Archivo; src: url(data:font/woff2;base64,${font.toString('base64')}); font-weight: 100 900; font-stretch: 62% 125%; }
        body { margin: 0; width: 1200px; height: 630px; overflow: hidden; background: radial-gradient(70% 90% at 85% 25%, ${theme.foam}, ${theme.paper} 72%); color: ${theme.ink}; font-family: Archivo, sans-serif; }
        .water { position: absolute; inset: 0; width: 100%; height: 100%; }
        /* Still water under the text, the wake on the right: the same mask as the home page's hero. */
        .calm { position: absolute; inset: 0; background: linear-gradient(90deg, ${theme.paper} 0 40%, transparent 74%); }
        .brand { position: absolute; top: 52px; left: 64px; display: flex; align-items: center; gap: 12px; font-size: 30px; font-weight: 680; font-stretch: 112%; letter-spacing: -0.9px; }
        .brand svg { width: 42px; height: 42px; color: ${theme.wake}; }
        /* Title and line stack, so a title on two lines pushes the line down instead of covering it. */
        .copy { position: absolute; left: 64px; top: 0; bottom: 96px; width: 940px; display: flex; flex-direction: column; justify-content: center; gap: 26px; }
        h1 { margin: 0; font-size: ${title.length > 16 ? 78 : 92}px; line-height: 1; letter-spacing: -2.4px; font-weight: 620; font-stretch: 114%; text-wrap: balance; }
        p { margin: 0; width: 780px; font-size: 30px; line-height: 1.3; color: #47566b; }
        small { position: absolute; left: 64px; bottom: 52px; font-size: 22px; color: #47566b; }
      </style></head><body>
        <svg class="water" viewBox="0 0 1920 1080" preserveAspectRatio="xMidYMid slice" fill="none" aria-hidden="true">${posterWater(theme)}</svg>
        <div class="calm"></div>
        <div class="brand">${symbol}<span>Sillage</span></div>
        <div class="copy"><h1>${title}</h1><p>${line}</p></div>
        <small>marlburrow.github.io/sillage</small>
      </body></html>`)
      await page.evaluate(() => document.fonts.ready)
      await page.screenshot({ path: fileURLToPath(new URL(`${folder}${name}.png`, root)) })
    }
  } finally {
    await page.close()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const browser = await chromium.launch({ chromiumSandbox: true })
  try {
    for (const language of ['en', 'fr']) {
      await renderSiteSocialImage(browser, language)
      await renderPageCards(browser, language)
    }
    await renderFilmPosters(browser)
  } finally {
    await browser.close()
  }
}
