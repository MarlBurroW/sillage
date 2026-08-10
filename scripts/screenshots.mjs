#!/usr/bin/env node
/**
 * Capture les écrans du site depuis une instance de démo déjà lancée et seedée
 * (voir `apps/server/src/cli/demo-seed.ts`, puis `pnpm --filter @sillage/server
 * search:reindex` pour que la palette de recherche ait des résultats).
 *
 *   SILLAGE_URL=http://127.0.0.1:7517 node scripts/screenshots.mjs
 *
 * Chaque vue sort en deux versions, `<nom>-dark.png` et `<nom>-light.png`, dans
 * `site/screenshots/`. Locale forcée en anglais : le site est en anglais.
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

async function fetchJson(context, path) {
  const response = await context.request.get(`${BASE_URL}${path}`)
  if (!response.ok()) throw new Error(`GET ${path} failed: ${response.status()}`)
  return response.json()
}

/** Retrouve les identifiants seedés, pour construire la liste des vues. */
async function resolveTargets(context) {
  const projects = await fetchJson(context, '/api/projects')
  const project = (name) => {
    const found = projects.find((p) => p.name === name)
    if (!found) throw new Error(`Project "${name}" not found — run the demo seed first.`)
    return found
  }
  const nimbus = project('Nimbus')
  const atlas = project('Atlas API')
  const conversationsOf = async (projectId) =>
    fetchJson(context, `/api/projects/${projectId}/conversations`)
  const byTitle = (list, title) => {
    const found = list.find((c) => c.title === title)
    if (!found) throw new Error(`Conversation "${title}" not found — reseed the demo data.`)
    return found
  }
  const nimbusThreads = await conversationsOf(nimbus.id)
  const atlasThreads = await conversationsOf(atlas.id)
  return {
    nimbus,
    hero: byTitle(nimbusThreads, 'Add offline caching for forecasts'),
    permission: byTitle(nimbusThreads, 'Refactor settings storage'),
    release: byTitle(nimbusThreads, 'Release notes for v0.9'),
    atlas,
    codex: byTitle(atlasThreads, 'Fix the flaky retry test'),
  }
}

/**
 * Les vues à capturer. `interact` joue un geste après le chargement (ouvrir un
 * tiroir, la palette…) ; `viewport` remplace le format par défaut pour la vue.
 */
function buildShots(t) {
  return [
    { name: 'login', path: '/login', waitFor: 'input[autocomplete="username"]', anonymous: true },
    {
      name: 'hero',
      path: `/p/${t.nimbus.id}/c/${t.hero.id}`,
      waitFor: 'text=Offline fallback is in place',
    },
    {
      name: 'permission',
      path: `/p/${t.nimbus.id}/c/${t.permission.id}`,
      waitFor: 'text=migrate-settings',
    },
    {
      name: 'codex',
      path: `/p/${t.atlas.id}/c/${t.codex.id}`,
      waitFor: 'text=advances the fake timer',
    },
    {
      name: 'release',
      path: `/p/${t.nimbus.id}/c/${t.release.id}`,
      waitFor: 'text=Vector radar tiles',
    },
    {
      name: 'board',
      path: `/p/${t.nimbus.id}/board`,
      waitFor: 'text=Offline caching for forecasts',
      viewport: BOARD_VIEWPORT,
    },
    {
      name: 'card',
      path: `/p/${t.nimbus.id}/board?carte=2`,
      waitFor: 'text=Cache layer and offline fallback',
      viewport: BOARD_VIEWPORT,
    },
    {
      name: 'search',
      path: `/p/${t.nimbus.id}/c/${t.hero.id}`,
      waitFor: 'text=Offline fallback is in place',
      interact: async (page) => {
        await page.keyboard.press('Control+k')
        const input = await page.waitForSelector('div[role="dialog"] input', { timeout: 10000 })
        await input.type('offline', { delay: 40 })
        // Les résultats arrivent en une requête, sans marqueur de fin : petite marge.
        await page.waitForTimeout(1200)
      },
    },
    { name: 'settings-mcp', path: '/settings/mcp', waitFor: 'text=playwright' },
    { name: 'settings-appearance', path: '/settings/apparence', waitFor: 'text=Shared with the accent color' },
    // Les vues du panneau latéral ferment la liste : leur `storage` (panneau ouvert)
    // reste posé dans le contexte, et rien ne doit se capturer après elles.
    {
      name: 'panel-files',
      path: `/p/${t.nimbus.id}/c/${t.hero.id}`,
      waitFor: 'text=Offline fallback is in place',
      storage: { 'sillage.panelOpen': '1' },
      viewport: BOARD_VIEWPORT,
      interact: async (page) => {
        const panel = page.locator('[data-panel="workspace"]')
        await panel.waitFor({ timeout: 10000 })
        // Déplier jusqu'au fichier, puis attendre que l'éditeur montre son contenu.
        await panel.locator('text=src').first().click()
        await panel.locator('text=lib').first().click()
        await panel.locator('text=forecast.ts').first().click()
        await panel.locator('text=API_BASE').first().waitFor({ timeout: 10000 })
      },
    },
    {
      name: 'panel-git',
      path: `/p/${t.nimbus.id}/c/${t.hero.id}`,
      waitFor: 'text=Offline fallback is in place',
      storage: { 'sillage.panelOpen': '1' },
      viewport: BOARD_VIEWPORT,
      interact: async (page) => {
        const panel = page.locator('[data-panel="workspace"]')
        await panel.waitFor({ timeout: 10000 })
        await panel.locator('text=Git').first().click()
        await panel.locator('text=Cache the last forecast per city').first().waitFor({ timeout: 10000 })
        // Déplier le diff du fichier principal, pour montrer de vrais hunks.
        await panel.locator('text=src/lib/forecast.ts').first().click()
        await panel.locator('text=fromCache').first().waitFor({ timeout: 10000 })
      },
    },
  ]
}

async function shoot(page, shot, file) {
  await page.setViewportSize(shot.viewport ?? VIEWPORT)
  await page.goto(`${BASE_URL}${shot.path}`)
  if (shot.storage) {
    // Les clés lues au chargement du module (panneau ouvert…) demandent un reload.
    await page.evaluate((entries) => {
      for (const [key, value] of entries) localStorage.setItem(key, value)
    }, Object.entries(shot.storage))
    await page.reload()
  }
  if (shot.waitFor) await page.waitForSelector(shot.waitFor, { timeout: 15000 })
  if (shot.interact) await shot.interact(page)
  // Les transitions d'entrée et le stream WebSocket se posent en un instant.
  await page.waitForTimeout(900)
  await page.screenshot({ path: join(OUT_DIR, file) })
  console.log(`✓ ${file}`)
}

async function captureTheme(browser, theme, shots) {
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

  const page = await context.newPage()
  // La page de connexion se capture avant de poser le cookie de session.
  for (const shot of shots.filter((s) => s.anonymous)) {
    await shoot(page, shot, `${shot.name}-${theme}.png`)
  }
  const login = await context.request.post(`${BASE_URL}/api/auth/login`, {
    data: { username: USERNAME, password: PASSWORD },
  })
  if (!login.ok()) throw new Error(`Login failed: ${login.status()} ${await login.text()}`)
  for (const shot of shots.filter((s) => !s.anonymous)) {
    await shoot(page, shot, `${shot.name}-${theme}.png`)
  }
  await context.close()
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const browser = await chromium.launch()

  // Un contexte éphémère résout les identifiants, valables pour les deux thèmes.
  const probe = await browser.newContext()
  const login = await probe.request.post(`${BASE_URL}/api/auth/login`, {
    data: { username: USERNAME, password: PASSWORD },
  })
  if (!login.ok()) throw new Error(`Login failed: ${login.status()} ${await login.text()}`)
  const shots = buildShots(await resolveTargets(probe))
  await probe.close()

  for (const theme of ['dark', 'light']) {
    await captureTheme(browser, theme, shots)
  }

  await browser.close()
  console.log(`\nScreenshots written to ${OUT_DIR}`)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err)
  process.exit(1)
})
