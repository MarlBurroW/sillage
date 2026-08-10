#!/usr/bin/env node
/**
 * Capture les écrans du site depuis une instance de démo déjà lancée et seedée
 * (voir `apps/server/src/cli/demo-seed.ts`).
 *
 *   SILLAGE_URL=http://127.0.0.1:7517 node scripts/screenshots.mjs
 *
 * Les captures sortent dans `site/screenshots/`, en clair et en sombre pour le hero,
 * en sombre seul pour le reste. Locale forcée en anglais : le site est en anglais.
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const BASE_URL = process.env.SILLAGE_URL ?? 'http://127.0.0.1:7517'
const USERNAME = process.env.SILLAGE_DEMO_USER ?? 'alex'
const PASSWORD = process.env.SILLAGE_DEMO_PASSWORD ?? 'sillage-demo'
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'site', 'screenshots')

const VIEWPORT = { width: 1600, height: 1000 }
/** Plus large pour le board : les cinq colonnes tiennent sans coupe. */
const BOARD_VIEWPORT = { width: 1840, height: 1100 }

async function newContext(browser, theme) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    locale: 'en-US',
    colorScheme: theme === 'light' ? 'light' : 'dark',
    serviceWorkers: 'block',
  })
  await context.addInitScript((value) => {
    localStorage.setItem('sillage.theme', value)
    document.documentElement.dataset.theme = value
  }, theme)
  const login = await context.request.post(`${BASE_URL}/api/auth/login`, {
    data: { username: USERNAME, password: PASSWORD },
  })
  if (!login.ok()) throw new Error(`Login failed: ${login.status()} ${await login.text()}`)
  return context
}

async function fetchJson(context, path) {
  const response = await context.request.get(`${BASE_URL}${path}`)
  if (!response.ok()) throw new Error(`GET ${path} failed: ${response.status()}`)
  return response.json()
}

async function shoot(page, path, file, { waitFor, settle = 900 } = {}) {
  await page.goto(`${BASE_URL}${path}`)
  if (waitFor) await page.waitForSelector(waitFor, { timeout: 15000 })
  // Les transitions d'entrée et le stream WebSocket se posent en un instant.
  await page.waitForTimeout(settle)
  await page.screenshot({ path: join(OUT_DIR, file) })
  console.log(`✓ ${file}`)
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const browser = await chromium.launch()

  const dark = await newContext(browser, 'dark')
  const page = await dark.newPage()

  const projects = await fetchJson(dark, '/api/projects')
  const nimbus = projects.find((p) => p.name === 'Nimbus')
  if (!nimbus) throw new Error('Nimbus project not found — run the demo seed first.')
  const conversations = await fetchJson(dark, `/api/projects/${nimbus.id}/conversations`)
  const byTitle = (title) => {
    const found = conversations.find((c) => c.title === title)
    if (!found) throw new Error(`Conversation "${title}" not found — reseed the demo data.`)
    return found
  }
  const hero = byTitle('Add offline caching for forecasts')
  const permission = byTitle('Refactor settings storage')

  const atlas = projects.find((p) => p.name === 'Atlas API')
  if (!atlas) throw new Error('Atlas API project not found — run the demo seed first.')
  const atlasConversations = await fetchJson(dark, `/api/projects/${atlas.id}/conversations`)
  const codexThread = atlasConversations.find((c) => c.title === 'Fix the flaky retry test')
  if (!codexThread) throw new Error('Codex conversation not found — reseed the demo data.')

  await shoot(page, `/p/${nimbus.id}/c/${hero.id}`, 'hero-dark.png', {
    waitFor: 'text=Offline fallback is in place',
  })
  await shoot(page, `/p/${nimbus.id}/c/${permission.id}`, 'permission-dark.png', {
    waitFor: 'text=migrate-settings',
  })
  await shoot(page, `/p/${atlas.id}/c/${codexThread.id}`, 'codex-dark.png', {
    waitFor: 'text=advances the fake timer',
  })
  await shoot(page, '/settings/mcp', 'settings-mcp-dark.png', { waitFor: 'text=playwright' })
  await page.setViewportSize(BOARD_VIEWPORT)
  await shoot(page, `/p/${nimbus.id}/board`, 'board-dark.png', {
    waitFor: 'text=Offline caching for forecasts',
  })
  await page.close()

  const light = await newContext(browser, 'light')
  const lightPage = await light.newPage()
  await shoot(lightPage, `/p/${nimbus.id}/c/${hero.id}`, 'hero-light.png', {
    waitFor: 'text=Offline fallback is in place',
  })
  await lightPage.setViewportSize(BOARD_VIEWPORT)
  await shoot(lightPage, `/p/${nimbus.id}/board`, 'board-light.png', {
    waitFor: 'text=Offline caching for forecasts',
  })
  await lightPage.close()

  await browser.close()
  console.log(`\nScreenshots written to ${OUT_DIR}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err)
  process.exit(1)
})
